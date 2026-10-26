const axios = require('axios');
const crypto = require('crypto');
const net = require('net');
const { httpsAgent, authenticatedNodeOrigin } = require('./nodeAuthentication');

// This endpoint is served by the HTTPS gateway's HAProxy, not by a FluxOS
// backend. A backend cannot nominate its own peers or fabricate extra votes.
const DISCOVERY_URL = 'https://api.runonflux.io/fluxstatistics;csv';
const backendCache = { nodes: null, expires: 0, pending: null };
const values = new Map();
const pending = new Map();
const requestOptions = {
  httpsAgent,
  timeout: 10000,
  maxRedirects: 0,
  maxContentLength: 8 * 1024 * 1024,
  headers: { 'x-apicache-bypass': 'true', 'Cache-Control': 'no-cache' },
};

function consensusError(message) {
  const error = new Error(message);
  error.code = 'REGISTRY_CONSENSUS_UNAVAILABLE';
  return error;
}

function parseBackendPool(csv) {
  if (typeof csv !== 'string') throw consensusError('Invalid API gateway statistics');
  const lines = csv.trim().replace(/^#\s*/, '').split(/\r?\n/);
  const columns = lines.shift().split(',');
  const index = Object.fromEntries(['pxname', 'svname', 'status'].map((name) => [name, columns.indexOf(name)]));
  if (Object.values(index).some((value) => value < 0)) throw consensusError('API backend statistics are unavailable');
  const nodes = new Map();
  lines.forEach((line) => {
    // These three columns precede the free-text CSV fields in HAProxy's format.
    const fields = line.split(',');
    if (fields[index.pxname] !== 'apirunonfluxiobackend' || fields[index.status] !== 'UP') return;
    const match = /^server\d+_(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/.exec(fields[index.svname]);
    if (!match || !net.isIPv4(match[1])) return;
    const port = Number(match[2] || 16127);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const origin = authenticatedNodeOrigin(`http://${match[1]}:${port}`);
    if (!origin.startsWith('https://')) return;
    nodes.set(match[1], origin);
  });
  if (nodes.size < 3) throw consensusError('At least three distinct API backend IPs are required');
  return [...nodes.values()];
}

async function getBackendPool() {
  if (backendCache.nodes && backendCache.expires > Date.now()) return backendCache.nodes;
  if (!backendCache.pending) {
    backendCache.pending = axios.get(DISCOVERY_URL, { ...requestOptions, responseType: 'text' })
      .then((response) => {
        if (response.status !== 200) throw consensusError('API backend discovery failed');
        const nodes = parseBackendPool(response.data);
        backendCache.nodes = nodes;
        backendCache.expires = Date.now() + 5 * 60 * 1000;
        return nodes;
      })
      .finally(() => { backendCache.pending = null; });
  }
  return backendCache.pending;
}

async function sample(endpoint, normalize) {
  const pool = [...await getBackendPool()];
  const selected = [];
  while (selected.length < 3) selected.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
  return Promise.all(selected.map(async (origin) => {
    try {
      const response = await axios.get(`${origin}${endpoint}`, requestOptions);
      if (response.status !== 200) return { origin, valid: false };
      return { origin, valid: true, value: normalize(response.data) };
    } catch (error) {
      return { origin, valid: false };
    }
  }));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function majority(responses) {
  const votes = new Map();
  responses.filter((response) => response.valid).forEach(({ value }) => {
    const key = JSON.stringify(canonical(value));
    const vote = votes.get(key) || { value, count: 0 };
    vote.count += 1;
    votes.set(key, vote);
  });
  const agreed = [...votes.values()].find((vote) => vote.count >= 2);
  if (!agreed) throw consensusError('Independent API backends did not agree');
  return agreed.value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function cached(key, ttl, operation, fresh = false) {
  const existing = values.get(key);
  if (!fresh && existing && existing.expires > Date.now()) return clone(existing.value);
  if (!pending.has(key)) {
    const result = operation().then((value) => {
      // Cache only confirmed answers; never retain a failed or partial quorum.
      if (values.size > 2000) values.delete(values.keys().next().value);
      values.set(key, { value: clone(value), expires: Date.now() + ttl });
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, result);
  }
  return clone(await pending.get(key));
}

function normalizeSpec(body, appname) {
  if (body?.status === 'error' && body.data?.message === 'Application not found') return null;
  const spec = body?.data;
  if (body?.status !== 'success' || !spec || typeof spec !== 'object' || Array.isArray(spec)
    || typeof spec.name !== 'string' || spec.name.toLowerCase() !== appname.toLowerCase()
    || typeof spec.owner !== 'string' || !spec.owner || spec.owner.length > 256
    || !Number.isSafeInteger(spec.height) || spec.height < 0
    || !Number.isSafeInteger(spec.expire) || spec.expire < 0
    || !Number.isSafeInteger(spec.height + spec.expire)) {
    throw consensusError('Invalid app specification');
  }
  return spec;
}

async function getAppSpecs(appname, { fresh = false } = {}) {
  if (typeof appname !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(appname)) throw consensusError('Invalid app name');
  return cached(`spec:${appname.toLowerCase()}`, 60000, async () => majority(await sample(
    `/apps/appspecifications/${encodeURIComponent(appname)}`,
    (body) => canonical(normalizeSpec(body, appname)),
  )), fresh);
}

function normalizeLocations(body) {
  if (body?.status !== 'success' || !Array.isArray(body.data) || body.data.length > 4096) {
    throw consensusError('Invalid app locations');
  }
  return [...new Set(body.data.map((location) => {
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/.exec(location?.ip);
    if (!match || !net.isIPv4(match[1])) throw consensusError('Invalid app node address');
    const port = Number(match[2] || 16127);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw consensusError('Invalid node port');
    return `${match[1]}:${port}`;
  }))].sort();
}

async function getLocations(appname) {
  if (typeof appname !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(appname)) throw consensusError('Invalid app name');
  return cached(`locations:${appname.toLowerCase()}`, 15000, async () => {
    const responses = await sample(`/apps/location/${encodeURIComponent(appname)}`, normalizeLocations);
    const votes = new Map();
    responses.filter((response) => response.valid).forEach(({ value }) => {
      value.forEach((node) => votes.set(node, (votes.get(node) || 0) + 1));
    });
    const locations = [...votes].filter(([, count]) => count >= 2).map(([ip]) => ({ ip }));
    if (!locations.length && responses.filter((response) => response.valid && response.value.length === 0).length < 2) {
      throw consensusError('No app locations were confirmed by independent backends');
    }
    return locations.sort((left, right) => left.ip.localeCompare(right.ip));
  });
}

async function getBlockHeight() {
  return cached('height', 10000, async () => {
    const responses = await sample('/daemon/getblockcount', (body) => {
      if (body?.status !== 'success' || !Number.isSafeInteger(body.data) || body.data < 1000) throw consensusError('Invalid block height');
      return body.data;
    });
    const heights = responses.filter((response) => response.valid).map((response) => response.value).sort((a, b) => a - b);
    if (heights.length < 2) throw consensusError('Block height could not be confirmed');
    const close = heights.slice(1).some((height, index) => height - heights[index] <= 6);
    if (!close) throw consensusError('Independent block heights diverged');
    return heights[Math.floor((heights.length - 1) / 2)];
  });
}

function clearCaches() {
  values.clear();
  pending.clear();
  backendCache.nodes = null;
  backendCache.expires = 0;
  backendCache.pending = null;
}

module.exports = {
  getAppSpecs, getLocations, getBlockHeight, testHooks: { clearCaches, parseBackendPool },
};
