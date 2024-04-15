/* eslint-disable no-unused-vars */
const mySql = require('mysql2/promise');
const net = require('net');
const config = require('../../../config/default');
const log = require('../../lib/log');
const Vault = require('../Vault');

class DBClient {
  constructor() {
    this.connection = {};
    this.connected = false;
    this.InitDB = 'backup';
    this.stream = null;
    this.dbPass = null;
  }

  /**
  * [init]
  */
  async createStream() {
    this.stream = net.connect({
      host: config.dbHost,
      port: config.dbPort,
    });
    const { stream } = this;
    return new Promise((resolve, reject) => {
      stream.once('connect', () => {
        stream.removeListener('error', reject);
        resolve(stream);
      });
      stream.once('error', (err) => {
        stream.removeListener('connection', resolve);
        stream.removeListener('data', resolve);
        console.log('error creating stream.');
        reject(err);
      });
    });
  }

  /**
  * [init]
  */
  async init() {
    this.dbPass = await Vault.getKey('dbpass');
    await this.createStream();
    this.connection = await mySql.createConnection({
      password: this.dbPass,
      user: config.dbUser,
      stream: this.stream,
    });
    this.connection.once('error', () => {
      this.connected = false;
      log.info(`Connecten to ${this.InitDB} DB was lost`);
    });
    this.connected = true;
  }

  /**
  * [query]
  * @param {string} query [description]
  */
  async query(query) {
    try {
      if (!this.connected) {
        log.info(`Connecten to ${this.InitDB} DB was lost, reconnecting...`);
        await this.init();
        this.setDB(this.InitDB);
      }
      const [rows, err] = await this.connection.query(query);
      if (err && err.toString().includes('Error')) log.error(`Error running query: ${err.toString()}, ${query}`);
      return rows;
    } catch (err) {
      if (err && err.toString().includes('Error')) log.error(`Error running query: ${err.toString()}, ${query}`);
      return [null, null, err];
    }
  }

  /**
  * [execute]
  * @param {string} query [description]
  * @param {array} params [description]
  */
  async execute(query, params) {
    try {
      if (!this.connected) {
        await this.init();
        this.setDB(this.InitDB);
      }
      const [rows, fields, err] = await this.connection.execute(query, params);
      if (err && err.toString().includes('Error')) log.error(`Error executing query: ${err.toString()}`);
      return rows;
    } catch (err) {
      if (err && err.toString().includes('Error')) log.error(`Error executing query: ${err.toString()}`);
      return [null, null, err];
    }
  }

  /**
  * [createDB]
  * @param {string} dbName [description]
  */
  async createDB(dbName) {
    try {
      await this.query(`CREATE DATABASE IF NOT EXISTS ${dbName}`);
    } catch (err) {
      log.info(`DB ${dbName} exists`);
    }
  }

  /**
  * [setDB]
  * @param {string} dbName [description]
  */
  async setDB(dbName) {
    this.connection.changeUser({
      database: dbName,
    }, (err) => {
      if (err) {
        console.log('Error changing database');
      }
    });
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
      params.push(task[key]);
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
        if (key === 'status') params.push(JSON.stringify(task[key]));
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
    const result = await this.execute('SELECT timestamp, component, hash, filesize FROM tasks where owner = ? and appname = ? and finishTime <> 0 and uploaded = 1 order by timestamp', [owner, appname]);
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
  }
}

// eslint-disable-next-line func-names
exports.createClient = async function () {
  try {
    const cl = new DBClient();
    await cl.init();
    return cl;
  } catch (err) {
    log.info(JSON.stringify(err));
    return null;
  }
};
