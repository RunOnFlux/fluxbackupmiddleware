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
  const currentPage = page(req.query.page);
  let cursor = { a: '', m: '' };
  if (req.query.cursor !== undefined) {
    try {
      if (typeof req.query.cursor !== 'string' || req.query.cursor.length > 512) throw new Error('Invalid cursor');
      cursor = JSON.parse(req.query.cursor);
      if (!cursor || typeof cursor.a !== 'string' || typeof cursor.m !== 'string'
        || cursor.a.length > 128 || cursor.m.length > 128) throw new Error('Invalid cursor');
    } catch (error) { return res.status(400).json({ error: 'Invalid app cursor' }); }
  }
  const pattern = `${q.replace(/[\\%_]/g, '\\$&')}%`;
  let autoCategory = '';
  if (category === 'marketplace') autoCategory = 'AND is_marketplace = 1';
  if (category === 'standard') autoCategory = 'AND (is_marketplace = 0 OR is_marketplace IS NULL)';
  const [automatic, manual] = await Promise.all([
    db.execute(`SELECT appname, is_marketplace, status, last_backup_timestamp
      FROM automatic_backups WHERE (status IS NULL OR status != 'cancelled')
      AND appname LIKE ? AND appname > ? ${autoCategory} ORDER BY appname LIMIT 26`, [pattern, cursor.a]),
    category === 'marketplace' ? Promise.resolve([]) : db.execute(`
      SELECT DISTINCT t.appname FROM tasks t
      WHERE t.appname LIKE ? AND t.appname > ? AND t.uploaded = 1 AND t.removedFromFluxdrive = 0
      AND NOT EXISTS (SELECT 1 FROM automatic_backups a WHERE a.appname = t.appname
        AND (a.status IS NULL OR a.status != 'cancelled'))
      ORDER BY t.appname LIMIT 26`, [pattern, cursor.m]),
  ]);
  const rows = [];
  let autoIndex = 0;
  let manualIndex = 0;
  let nextAuto = cursor.a;
  let nextManual = cursor.m;
  while (rows.length < pageSize && (autoIndex < automatic.length || manualIndex < manual.length)) {
    const useAuto = manualIndex >= manual.length || (autoIndex < automatic.length
      && automatic[autoIndex].appname <= manual[manualIndex].appname);
    if (useAuto) {
      rows.push(automatic[autoIndex]);
      nextAuto = automatic[autoIndex].appname;
      autoIndex += 1;
    } else {
      const name = manual[manualIndex].appname;
      rows.push({
        appname: name, is_marketplace: 0, status: 'Stored', last_backup_timestamp: 0,
      });
      nextManual = name;
      manualIndex += 1;
    }
  }
  const hasMore = autoIndex < automatic.length || manualIndex < manual.length;
  let fileStats = [];
  if (rows.length) {
    const placeholders = rows.map(() => '?').join(', ');
    fileStats = await db.execute(`SELECT appname, COUNT(*) AS files, COALESCE(SUM(filesize), 0) AS bytes,
      MAX(finishTime) AS last_finished FROM tasks WHERE appname IN (${placeholders})
      AND uploaded = 1 AND removedFromFluxdrive = 0 GROUP BY appname`, rows.map((row) => row.appname));
  }
  const filesByName = new Map(fileStats.map((row) => [row.appname, row]));
  return res.set('Cache-Control', 'no-store').json({
    page: currentPage,
    pageSize,
    hasMore,
    nextCursor: hasMore ? JSON.stringify({ a: nextAuto, m: nextManual }) : null,
    rows: rows.map((row) => ({
      name: row.appname,
      category: row.is_marketplace ? 'Marketplace' : 'Standard',
      status: row.status || 'Unknown',
      lastBackup: number(row.last_backup_timestamp) || number(filesByName.get(row.appname)?.last_finished),
      files: number(filesByName.get(row.appname)?.files),
      bytes: number(filesByName.get(row.appname)?.bytes),
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
    ORDER BY taskId DESC LIMIT ${pageSize} OFFSET ${offset}`, [appname]);
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
