const https = require('https');
const net = require('net');

const httpsAgent = new https.Agent({ rejectUnauthorized: true });

function securityError(message, code = 'INVALID_NODE_URL') {
  const error = new Error(message);
  error.code = code;
  error.terminal = true;
  return error;
}

function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw securityError('Invalid backup node URL', 'INVALID_BACKUP_URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw securityError('Backup URLs must use HTTP(S) without credentials or fragments', 'INVALID_BACKUP_URL');
  }
  return url;
}

function parseOrigin(value) {
  const url = parseHttpUrl(value);
  if (url.pathname !== '/' || url.search) {
    throw securityError('A trusted node entry must be an origin without a path or query');
  }
  return url;
}

function fluxHttpsOrigin(value) {
  const url = parseOrigin(value);
  const loopback = url.hostname.startsWith('127.');
  if (url.protocol === 'http:' && net.isIPv4(url.hostname) && !loopback) {
    const port = url.port || '80';
    return `https://${url.hostname.replace(/\./g, '-')}-${port}.node.api.runonflux.io`;
  }
  return url.origin;
}

function authenticatedNodeOrigin(node) {
  const origin = fluxHttpsOrigin(node);
  const url = new URL(origin);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw securityError('Authenticated node requests require HTTPS', 'INSECURE_NODE_URL');
  }
  return origin;
}

function authenticatedNodeUrl(value) {
  const url = parseHttpUrl(value);
  const origin = authenticatedNodeOrigin(url.origin);
  const target = new URL(origin);
  target.pathname = url.pathname;
  target.search = url.search;
  return target;
}

function isValidNodeLoginPhrase(message, now = Date.now()) {
  if (typeof message !== 'string' || message.trim() !== message || !/^\d{13}[a-z0-9]{27,57}$/.test(message)) return false;
  const timestamp = Number(message.slice(0, 13));
  return Number.isFinite(timestamp) && timestamp >= now - 15 * 60 * 1000 && timestamp <= now + 30000;
}

function teamAuthFailure(node, error) {
  return {
    zelidAuth: null,
    reason: error.message,
    diagnostics: [{
      check: 'Authenticated node destination', outcome: 'failed', node, errorCode: error.code, detail: error.message,
    }],
  };
}

module.exports = {
  httpsAgent,
  parseHttpUrl,
  fluxHttpsOrigin,
  authenticatedNodeOrigin,
  authenticatedNodeUrl,
  isValidNodeLoginPhrase,
  teamAuthFailure,
  securityError,
};
