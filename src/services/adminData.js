const fs = require('fs');
const path = require('path');
const backupService = require('./backupService');
const config = require('../../config/default');

const db = {
  execute: (...args) => {
    const client = backupService.getDatabase();
    if (!client) throw new Error('Backup database is not ready');
    return client.execute(...args);
  },
};

const pageSize = 25;
function number(value, fallback = 0) { return Number(value) || fallback; }
function page(value) { return Math.min(Math.max(parseInt(value, 10) || 0, 0), 10000); }
function safeHash(hash) { return typeof hash === 'string' && /^[a-zA-Z0-9]+$/.test(hash) ? hash : null; }
function taskState(row) {
  if (row.uploaded) return 'Completed';
  if (row.fails >= 4) return 'Failed';
  try { return JSON.parse(row.status || '{}').state || 'Queued'; } catch (error) { return 'Unknown'; }
}

async function dashboard(req, res) {
  const since = (Math.floor(Date.now() / 86400000) - 6) * 86400000;
  const [stats] = await db.execute(`
    SELECT COUNT(*) AS total,
      SUM(finishTime = 0 AND uploaded = 0 AND fails < 4 AND startTime > 0 AND removedFromFluxdrive = 0) AS running,
      SUM(uploaded = 1 AND removedFromFluxdrive = 0 AND finishTime >= ?) AS completed7d,
      SUM(CASE WHEN uploaded = 1 AND removedFromFluxdrive = 0 THEN COALESCE(filesize, 0) ELSE 0 END) AS storedBytes,
      SUM(CASE WHEN uploaded = 1 AND removedFromFluxdrive = 0 AND finishTime >= ? THEN COALESCE(filesize, 0) ELSE 0 END) AS addedBytes7d
    FROM tasks`, [since, since]);
  const [appStats] = await db.execute(`
    SELECT COUNT(*) AS total,
      SUM(is_marketplace = 1) AS marketplace,
      SUM(is_marketplace = 1 AND first_seen_at >= ?) AS newMarketplace7d
    FROM automatic_backups WHERE status IS NULL OR status != 'cancelled'`, [since]);
  const daily = await db.execute(`
    SELECT FLOOR(finishTime / 86400000) AS day, COUNT(*) AS count
    FROM tasks WHERE uploaded = 1 AND removedFromFluxdrive = 0 AND finishTime >= ?
    GROUP BY day ORDER BY day`, [since]);
  const recent = await db.execute(`
    SELECT taskId, appname, component, filesize, finishTime, uploaded, fails, status
    FROM tasks ORDER BY taskId DESC LIMIT 8`);
  res.set('Cache-Control', 'no-store').json({
    stats: {
      running: number(stats.running),
      completed7d: number(stats.completed7d),
      storedBytes: number(stats.storedBytes),
      addedBytes7d: number(stats.addedBytes7d),
      apps: number(appStats.total),
      marketplace: number(appStats.marketplace),
      newMarketplace7d: number(appStats.newMarketplace7d),
    },
    daily: daily.map((row) => ({ day: row.day, count: number(row.count) })),
    recent: recent.map((row) => ({
      id: row.taskId,
      appname: row.appname,
      component: row.component,
      bytes: number(row.filesize),
      time: number(row.finishTime),
      state: taskState(row),
    })),
  });
}

async function apps(req, res) {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const category = ['all', 'marketplace', 'standard'].includes(req.query.category) ? req.query.category : 'all';
  const offset = page(req.query.page) * pageSize;
  const source = `(SELECT appname FROM automatic_backups WHERE status IS NULL OR status != 'cancelled'
    UNION SELECT appname FROM tasks WHERE uploaded = 1 AND removedFromFluxdrive = 0) names
    LEFT JOIN automatic_backups a ON a.appname = names.appname`;
  const filter = `WHERE (? = '' OR names.appname LIKE ?)
    AND (? = 'all' OR (? = 'marketplace' AND a.is_marketplace = 1)
      OR (? = 'standard' AND (a.is_marketplace = 0 OR a.is_marketplace IS NULL)))`;
  const params = [q, `%${q.replace(/[\\%_]/g, '\\$&')}%`, category, category, category];
  const [count] = await db.execute(`SELECT COUNT(*) AS total FROM ${source} ${filter}`, params);
  const rows = await db.execute(`
    SELECT names.appname, a.is_marketplace, a.status, a.last_backup_timestamp,
      (SELECT COUNT(*) FROM tasks t WHERE t.appname = names.appname AND t.uploaded = 1 AND t.removedFromFluxdrive = 0) AS files,
      (SELECT COALESCE(SUM(t.filesize), 0) FROM tasks t WHERE t.appname = names.appname AND t.uploaded = 1 AND t.removedFromFluxdrive = 0) AS bytes
    FROM ${source} ${filter} ORDER BY names.appname LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  return res.set('Cache-Control', 'no-store').json({
    total: number(count.total),
    page: page(req.query.page),
    pageSize,
    rows: rows.map((row) => ({
      name: row.appname,
      category: row.is_marketplace ? 'Marketplace' : 'Standard',
      status: row.status || 'Unknown',
      lastBackup: number(row.last_backup_timestamp),
      files: number(row.files),
      bytes: number(row.bytes),
    })),
  });
}

async function backups(req, res) {
  const appname = String(req.query.appname || '');
  if (!appname || appname.length > 128) return res.status(400).json({ error: 'Invalid app name' });
  const offset = page(req.query.page) * pageSize;
  const [count] = await db.execute(`SELECT COUNT(*) AS total FROM tasks
    WHERE appname = ? AND uploaded = 1 AND removedFromFluxdrive = 0`, [appname]);
  const rows = await db.execute(`SELECT taskId, timestamp, component, filesize, hash, finishTime
    FROM tasks WHERE appname = ? AND uploaded = 1 AND removedFromFluxdrive = 0
    ORDER BY taskId DESC LIMIT ? OFFSET ?`, [appname, pageSize, offset]);
  const gateway = config.ipfsGatewayUrl.replace(/\/+$/, '');
  return res.set('Cache-Control', 'no-store').json({
    total: number(count.total),
    page: page(req.query.page),
    pageSize,
    rows: rows.map((row) => ({
      id: row.taskId,
      checkpoint: number(row.timestamp),
      component: row.component,
      bytes: number(row.filesize),
      time: number(row.finishTime),
      url: safeHash(row.hash) ? `${gateway}/${row.hash}` : null,
    })),
  });
}

async function logs(req, res) {
  const type = req.query.type === 'error' ? 'error' : 'debug';
  const search = String(req.query.q || '').trim().slice(0, 120).toLowerCase();
  const file = path.join(__dirname, '../../logs', `${type}.log`);
  let handle;
  try { handle = await fs.promises.open(file, 'r'); } catch (error) {
    if (error.code === 'ENOENT') return res.json({ rows: [], nextCursor: null });
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const supplied = Number(req.query.cursor);
    let cursor = Number.isSafeInteger(supplied) && supplied >= 0 && supplied <= size ? supplied : size;
    let pending = Buffer.alloc(0);
    const rows = [];
    const chunk = Buffer.alloc(64 * 1024);
    while (cursor > 0 && rows.length < 50) {
      const start = Math.max(0, cursor - chunk.length);
      // Reads must remain sequential because each chunk depends on the previous cursor.
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await handle.read(chunk, 0, cursor - start, start);
      cursor = start;
      let end = bytesRead;
      for (let i = bytesRead - 1; i >= 0; i -= 1) {
        if (chunk[i] === 10) {
          const line = Buffer.concat([chunk.subarray(i + 1, end), pending]).toString('utf8');
          pending = Buffer.alloc(0);
          end = i;
          if (line && (!search || line.toLowerCase().includes(search))) rows.push(line.slice(0, 4000));
          if (rows.length === 50) return res.set('Cache-Control', 'no-store').json({ rows, nextCursor: start + i || null });
        }
      }
      pending = Buffer.concat([chunk.subarray(0, end), pending]);
    }
    const firstLine = pending.toString('utf8');
    if (firstLine && (!search || firstLine.toLowerCase().includes(search))) rows.push(firstLine.slice(0, 4000));
    return res.set('Cache-Control', 'no-store').json({ rows, nextCursor: null });
  } finally { await handle.close(); }
}

module.exports = {
  dashboard, apps, backups, logs,
};
