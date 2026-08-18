/* eslint-disable no-unused-vars */
const mySql = require('mysql2/promise');
const config = require('../../../config/default');
const log = require('../../lib/log');
const Vault = require('../Vault');

const RETRYABLE_READ_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
]);

function summarizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().slice(0, 180);
}

function isReadOnlySql(sql) {
  return /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i.test(String(sql).trim());
}

function withTimeout(operation, timeoutMs, sqlSummary) {
  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`Database operation timed out after ${timeoutMs}ms`);
      error.code = 'DB_OPERATION_TIMEOUT';
      error.sqlSummary = sqlSummary;
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timeoutId));
}

/**
 * Sanitizes status object to ensure it doesn't exceed database column limit.
 * Truncates message to fit within VARCHAR(256) limit when JSON-serialized.
 * @param {Object} status - The status object with state, message, and progress
 * @returns {Object} - Sanitized status object
 */
function sanitizeStatus(status) {
  if (!status || typeof status !== 'object') {
    return status;
  }
  const sanitized = { ...status };
  // Reserve ~35 chars for JSON structure: {"state":"","progress":0}
  // Maximum message length to stay under 256 chars total
  const maxMessageLength = 180;
  if (sanitized.message && sanitized.message.length > maxMessageLength) {
    sanitized.message = `${sanitized.message.substring(0, maxMessageLength - 3)}...`;
  }
  return sanitized;
}

class DBClient {
  constructor() {
    this.connection = null;
    this.connected = false;
    this.InitDB = 'backup';
    this.dbPass = null;
    this.initPromise = null;
  }

  /**
  * [init]
  */
  async createPool() {
    this.dbPass = await Vault.getKey('dbpass');
    const host = config.dbHost || config.dbhost || '127.0.0.1';
    const baseOptions = {
      host,
      port: config.dbPort,
      user: config.dbUser,
      password: this.dbPass,
      connectTimeout: config.dbConnectTimeoutMs,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    };

    // Ensure a clean installation can create the database before the pool selects it.
    const bootstrapConnection = await mySql.createConnection(baseOptions);
    try {
      await withTimeout(
        bootstrapConnection.query({
          sql: `CREATE DATABASE IF NOT EXISTS \`${this.InitDB}\``,
          timeout: config.dbQueryTimeoutMs,
        }),
        config.dbOperationTimeoutMs,
        `CREATE DATABASE IF NOT EXISTS ${this.InitDB}`,
      );
    } finally {
      await bootstrapConnection.end();
    }

    const pool = mySql.createPool({
      ...baseOptions,
      database: this.InitDB,
      waitForConnections: true,
      connectionLimit: config.dbConnectionLimit,
      maxIdle: config.dbConnectionLimit,
      idleTimeout: 60000,
      queueLimit: 100,
    });

    pool.on('connection', (connection) => {
      log.info(`[DB] pooled connection established: threadId=${connection.threadId || 'unknown'}`);
      connection.on('error', (error) => {
        log.warn(`[DB] pooled connection error: code=${error.code || 'unknown'}, message=${error.message}`);
      });
    });
    pool.on('enqueue', () => {
      log.warn('[DB] connection pool is saturated; database operation queued');
    });

    try {
      await withTimeout(
        pool.query({ sql: 'SELECT 1', timeout: config.dbQueryTimeoutMs }),
        config.dbOperationTimeoutMs,
        'SELECT 1',
      );
    } catch (error) {
      await pool.end();
      throw error;
    }
    this.connection = pool;
    this.connected = true;
    log.info(`[DB] connection pool ready: host=${host}, database=${this.InitDB}, limit=${config.dbConnectionLimit}`);
  }

  /**
  * [init]
  */
  async init() {
    if (this.connected && this.connection) return;
    if (!this.initPromise) {
      this.initPromise = this.createPool().finally(() => {
        this.initPromise = null;
      });
    }
    await this.initPromise;
  }

  async runStatement(method, sql, params = []) {
    await this.init();
    const sqlSummary = summarizeSql(sql);
    const readOnly = isReadOnlySql(sql);
    const maxAttempts = readOnly ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      try {
        const options = { sql, timeout: config.dbQueryTimeoutMs };
        const operation = method === 'execute'
          ? this.connection.execute(options, params)
          : this.connection.query(options);
        // Retries are intentionally sequential so a stale read is attempted only once more.
        // eslint-disable-next-line no-await-in-loop
        const [rows] = await withTimeout(
          operation,
          config.dbOperationTimeoutMs,
          sqlSummary,
        );
        const durationMs = Date.now() - startedAt;
        if (durationMs >= config.dbSlowQueryMs) {
          log.warn(`[DB] slow ${method}: durationMs=${durationMs}, attempt=${attempt}, sql="${sqlSummary}"`);
        }
        return rows;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const code = error.code || 'unknown';
        const willRetry = readOnly
          && attempt < maxAttempts
          && RETRYABLE_READ_ERROR_CODES.has(code);
        log.error(`[DB] ${method} failed: durationMs=${durationMs}, attempt=${attempt}/${maxAttempts}, code=${code}, retry=${willRetry}, sql="${sqlSummary}", message=${error.message}`);
        if (!willRetry) throw error;
      }
    }

    throw new Error(`Database ${method} failed without a result`);
  }

  /**
  * [query]
  * @param {string} query [description]
  */
  async query(query) {
    return this.runStatement('query', query);
  }

  /**
  * [execute]
  * @param {string} query [description]
  * @param {array} params [description]
  */
  async execute(query, params) {
    return this.runStatement('execute', query, params);
  }

  /**
  * [createDB]
  * @param {string} dbName [description]
  */
  async createDB(dbName) {
    return this.query(`CREATE DATABASE IF NOT EXISTS ${dbName}`);
  }

  /**
  * [setDB]
  * @param {string} dbName [description]
  */
  async setDB(dbName) {
    if (dbName !== this.InitDB) {
      throw new Error(`Database pool is configured for ${this.InitDB}, not ${dbName}`);
    }
    await this.init();
  }

  /**
  * [getRecord]
  * @param {string} id [description]
  */
  async getTask(id) {
    if (!this.connected) await this.init();
    const result = await this.execute('SELECT * FROM tasks where taskId = ?', [id]);
    if (result.length) {
      const task = result[0];
      task.status = JSON.parse(task.status);
      return task;
    }
    return null;
  }

  /**
  * [removeTask]
  * @param {string} id [description]
  */
  async removeTask(id) {
    if (!this.connected) await this.init();
    const result = await this.execute('DELETE FROM tasks where taskId = ?', [id]);
    return result;
  }

  /**
  * [removeTask]
  * @param {string} id [description]
  */
  async softRemoveTask(id) {
    if (!this.connected) await this.init();
    const result = await this.execute('UPDATE tasks set removedFromFluxdrive = 1, uploaded = 0, reconciliationRecovered = 1 where taskId = ?', [id]);
    return result;
  }

  /**
  * [addNewTask]
  * @param {obj} task [description]
  */
  async addNewTask(task) {
    if (!this.connected) await this.init();
    let query = 'insert into tasks';
    let fields = ' (';
    let values = ') VALUES (';
    const params = [];
    // eslint-disable-next-line no-restricted-syntax, guard-for-in
    for (const key in task) {
      fields += `${key},`;
      values += '?,';
      if (key === 'status') {
        const statusValue = task[key];
        if (typeof statusValue === 'string') {
          params.push(statusValue);
        } else {
          const sanitizedStatus = sanitizeStatus(statusValue);
          params.push(JSON.stringify(sanitizedStatus));
        }
      } else {
        params.push(task[key]);
      }
    }
    fields = fields.slice(0, -1);
    values = values.slice(0, -1);
    query = `${query + fields + values})`;

    const result = await this.execute(query, params);
    return result;
  }

  /**
  * [updateTask]
  * @param {obj} task [description]
  */
  async updateTask(task) {
    if (!this.connected) await this.init();
    let query = 'update tasks set ';
    let fields = '';
    const params = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const key in task) {
      // eslint-disable-next-line no-prototype-builtins
      if (key !== 'taskId') {
        fields += ` ${key}=?,`;
        if (key === 'status') params.push(typeof task[key] === 'string' ? task[key] : JSON.stringify(task[key]));
        else params.push(task[key]);
      }
    }
    fields = fields.slice(0, -1);
    params.push(task.taskId);
    query = `${query + fields} where taskId=?`;

    const result = await this.execute(query, params);
    return result;
  }

  /**
  * [getUserBackups]
  * @param {string} owner [description]
  * @param {string} appname [description]
  */
  async getUserBackups(owner, appname) {
    if (!this.connected) await this.init();
    const result = await this.execute('SELECT timestamp, component, hash, filesize FROM tasks where owner = ? and appname = ? and uploaded = 1 and removedFromFluxdrive = 0 order by timestamp', [owner, appname]);
    if (result.length) {
      return result;
    }
    return null;
  }

  /**
  * [getUserCheckpoint]
  * @param {string} owner [description]
  * @param {string} appname [description]
  * @param {string} timestamp [description]
  */
  async getUserCheckpoint(owner, appname, timestamp) {
    if (!this.connected) await this.init();
    const result = await this.execute('SELECT taskId, timestamp, appname, component, hash, filename, filesize FROM tasks where owner = ? and appname = ? and timestamp = ? and finishTime <> 0', [owner, appname, timestamp]);
    if (result.length) {
      return result;
    }
    return null;
  }

  /**
  * [createSchema]
  */
  async checkSchema() {
    if (!this.connected) await this.init();
    const dbList = await this.query(`SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '${this.InitDB}'`);
    if (dbList.length === 0) {
      log.info(`${this.InitDB} DB not defined yet, creating ${this.InitDB} DB...`);
      await this.createDB(this.InitDB);
    } else {
      log.info(`${this.InitDB} DB already exists, moving on...`);
    }
    await this.setDB(this.InitDB);
    const tableList = await this.query(`SELECT * FROM INFORMATION_SCHEMA.tables 
          WHERE table_schema = '${this.InitDB}' and table_name = 'tasks'`);
    if (tableList.length === 0) {
      log.info('tasks table not defined yet, creating tasks table...');
      await this.query(`CREATE TABLE tasks (
        taskId bigint unsigned NOT NULL AUTO_INCREMENT,
        owner varchar(256) NOT NULL,
        timestamp bigint unsigned NOT NULL,
        filename varchar(128) NOT NULL,
        appname varchar(128) NOT NULL,
        component varchar(64) NOT NULL,
        filesize bigint,
        status varchar(256) DEFAULT '{"state":"in queue"}',
        uploaded tinyint DEFAULT '0',
        downloaded tinyint DEFAULT '0',
        localRemoved tinyint DEFAULT '0',
        remoteRemoved tinyint DEFAULT '0',
        removedFromFluxdrive tinyint DEFAULT '0',
        reconciliationRecovered tinyint DEFAULT '0',
        fails tinyint DEFAULT '0',
        host varchar(256),
        hash varchar(256),
        startTime bigint unsigned DEFAULT '0',
        finishTime bigint unsigned DEFAULT '0',
        appExpireHeight bigint unsigned DEFAULT '0',
        extra text,
        PRIMARY KEY (\`taskId\`),
        KEY \`appname_owner\` (\`appname\`,\`owner\`))ENGINE=InnoDB;`);
    } else {
      log.info('files table already exists, moving on...');
    }

    // Check and create automatic_backups table
    const autoBackupsTableList = await this.query(`SELECT * FROM INFORMATION_SCHEMA.tables
          WHERE table_schema = '${this.InitDB}' and table_name = 'automatic_backups'`);
    if (autoBackupsTableList.length === 0) {
      log.info('automatic_backups table not defined yet, creating automatic_backups table...');
      await this.query(`CREATE TABLE automatic_backups (
        id bigint unsigned NOT NULL AUTO_INCREMENT,
        appname varchar(128) NOT NULL UNIQUE,
        components JSON,
        backup_tasks JSON,
        status varchar(64),
        expire_counter int DEFAULT '0',
        last_backup_timestamp bigint unsigned DEFAULT '0',
        is_marketplace tinyint DEFAULT NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`appname_unique\` (\`appname\`))ENGINE=InnoDB;`);
    } else {
      log.info('automatic_backups table already exists, moving on...');
    }

    const marketplaceColumnCheck = await this.query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${this.InitDB}'
      AND TABLE_NAME = 'automatic_backups'
      AND COLUMN_NAME = 'is_marketplace'
    `);

    if (marketplaceColumnCheck.length === 0) {
      log.info('Adding is_marketplace column to automatic_backups table...');
      await this.query(`
        ALTER TABLE automatic_backups
        ADD COLUMN is_marketplace TINYINT DEFAULT NULL AFTER last_backup_timestamp
      `);
      log.info('is_marketplace column added successfully');
    } else {
      log.info('is_marketplace column already exists, moving on...');
    }

    await this.query(`CREATE TABLE IF NOT EXISTS enterprise_app_discovery (
      appname varchar(128) NOT NULL,
      spec_hash varchar(128) NOT NULL,
      has_syncthing tinyint NOT NULL DEFAULT '0',
      components JSON,
      repotags JSON,
      checked_at bigint unsigned NOT NULL,
      PRIMARY KEY (\`appname\`),
      KEY \`spec_hash_idx\` (\`spec_hash\`)
    )ENGINE=InnoDB;`);

    // Check if backup_type column exists in tasks table, if not add it
    const backupTypeColumnCheck = await this.query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${this.InitDB}'
      AND TABLE_NAME = 'tasks'
      AND COLUMN_NAME = 'backup_type'
    `);

    if (backupTypeColumnCheck.length === 0) {
      log.info('Adding backup_type column to tasks table...');
      await this.query(`
        ALTER TABLE tasks
        ADD COLUMN backup_type VARCHAR(32) DEFAULT 'manual' AFTER extra
      `);
      log.info('backup_type column added successfully');
    } else {
      log.info('backup_type column already exists, moving on...');
    }

    const reconciliationRecoveredColumnCheck = await this.query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${this.InitDB}'
      AND TABLE_NAME = 'tasks'
      AND COLUMN_NAME = 'reconciliationRecovered'
    `);

    if (reconciliationRecoveredColumnCheck.length === 0) {
      log.info('Adding reconciliationRecovered column to tasks table...');
      await this.query(`
        ALTER TABLE tasks
        ADD COLUMN reconciliationRecovered TINYINT DEFAULT '0' AFTER removedFromFluxdrive
      `);
      log.info('reconciliationRecovered column added successfully');
    } else {
      log.info('reconciliationRecovered column already exists, moving on...');
    }

    // Add index on backup_type for faster queries
    const backupTypeIndexCheck = await this.query(`
      SELECT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = '${this.InitDB}'
      AND TABLE_NAME = 'tasks'
      AND INDEX_NAME = 'backup_type_idx'
    `);

    if (backupTypeIndexCheck.length === 0) {
      log.info('Adding index on backup_type column...');
      await this.query(`
        ALTER TABLE tasks
        ADD INDEX backup_type_idx (backup_type, appname, owner, removedFromFluxdrive)
      `);
      log.info('backup_type index added successfully');
    } else {
      log.info('backup_type index already exists, moving on...');
    }
  }
}

// eslint-disable-next-line func-names
exports.createClient = async function () {
  try {
    const cl = new DBClient();
    await cl.init();
    return cl;
  } catch (err) {
    log.error(`[DB] client initialization failed: code=${err.code || 'unknown'}, message=${err.message}`);
    throw err;
  }
};

exports.DBClient = DBClient;
