const axios = require('axios');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const config = require('../../config/default');
const log = require('../lib/log');
const Vault = require('./Vault');

const FLUX_API = 'https://api.runonflux.io';
const ENTERPRISE_RSA_KEY_BYTES = 256;
const ENTERPRISE_NONCE_BYTES = 12;
const ENTERPRISE_AUTH_TAG_BYTES = 16;
const DECRYPTED_CACHE_MAX = 1000;
const DECRYPTED_CACHE_MIN_TTL_MS = 24 * 60 * 60 * 1000;
const decryptedSpecsCache = new Map();
let sasRuntimePromise = null;

function isEnterpriseApp(spec) {
  return !!(spec && spec.version >= 8 && spec.enterprise);
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function parseJson(data) {
  try {
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

function hydrate(value) {
  if (Array.isArray(value)) return value.map((item) => hydrate(item));
  if (!value || typeof value !== 'object') return value;

  return Object.entries(value).reduce((result, [key, item]) => {
    let hydratedItem;
    if (typeof item === 'string' && item.startsWith('[') && item.endsWith(']')) {
      const parsed = parseJson(item);
      hydratedItem = parsed === null ? item : hydrate(parsed);
    } else {
      hydratedItem = hydrate(item);
    }
    return { ...result, [key]: hydratedItem };
  }, {});
}

function getCachedDecryption(hash) {
  if (!hash) return null;
  const cached = decryptedSpecsCache.get(hash);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    decryptedSpecsCache.delete(hash);
    return null;
  }
  return cached.content;
}

function cacheDecryption(hash, content) {
  if (!hash) return;
  if (decryptedSpecsCache.size >= DECRYPTED_CACHE_MAX) {
    const oldestKey = decryptedSpecsCache.keys().next().value;
    decryptedSpecsCache.delete(oldestKey);
  }
  decryptedSpecsCache.set(hash, {
    content,
    expiresAt: Date.now() + DECRYPTED_CACHE_MIN_TTL_MS
      + Math.floor(Math.random() * DECRYPTED_CACHE_MIN_TTL_MS),
  });
}

async function getSasConfiguration() {
  const configured = config.sasApi || {};
  const [vaultBaseUrl, vaultKeyPath, vaultCertPath, vaultCaPath] = await Promise.all([
    Vault.getKey('sasApiBaseUrl'),
    Vault.getKey('sasKeyPath'),
    Vault.getKey('sasCertPath'),
    Vault.getKey('sasCaPath'),
  ]);
  const sasConfig = {
    baseUrl: configured.baseUrl || vaultBaseUrl,
    keyPath: configured.keyPath || vaultKeyPath,
    certPath: configured.certPath || vaultCertPath,
    caPath: configured.caPath || vaultCaPath,
    timeoutMs: configured.timeoutMs || 10000,
    retryAttempts: configured.retryAttempts || 4,
    retryDelayMs: configured.retryDelayMs || 16000,
  };
  const missing = ['baseUrl', 'keyPath', 'certPath', 'caPath']
    .filter((key) => !sasConfig[key]);
  if (missing.length > 0) {
    throw new Error(`SAS API configuration is incomplete; missing ${missing.join(', ')}`);
  }
  return sasConfig;
}

function createSasHttpsAgent(sasConfig) {
  try {
    return new https.Agent({
      key: fs.readFileSync(sasConfig.keyPath),
      cert: fs.readFileSync(sasConfig.certPath),
      ca: fs.readFileSync(sasConfig.caPath),
    });
  } catch (error) {
    throw new Error(`Failed to load SAS API mTLS certificates: ${error.message}`);
  }
}

async function getSasRuntime() {
  if (!sasRuntimePromise) {
    sasRuntimePromise = (async () => {
      const sasConfig = await getSasConfiguration();
      const decryptUrl = new URL(sasConfig.baseUrl);
      decryptUrl.pathname = path.posix.join(decryptUrl.pathname, 'decryptMessageRSA');
      return {
        sasConfig,
        httpsAgent: createSasHttpsAgent(sasConfig),
        decryptUrl: decryptUrl.href,
      };
    })();
  }
  return sasRuntimePromise;
}

async function assertSasConfigured() {
  await getSasRuntime();
  return true;
}

async function decryptAesKeyViaSas(
  appName,
  owner,
  encryptedAesKey,
  options = {},
) {
  const runtime = options.runtime || await getSasRuntime();
  const axiosClient = options.axiosClient || axios;
  const wait = options.delay || delay;
  const { sasConfig, httpsAgent: sasHttpsAgent, decryptUrl } = runtime;
  const payload = {
    fluxID: owner,
    appName,
    message: encryptedAesKey.toString('base64'),
    blockHeight: 9999999,
  };
  let lastError = null;

  for (let attempt = 1; attempt <= sasConfig.retryAttempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await axiosClient.post(decryptUrl, payload, {
        httpsAgent: sasHttpsAgent,
        timeout: sasConfig.timeoutMs,
      });
      const base64AesKey = response.data?.message;
      if (response.status === 200 && response.data?.status === 'ok' && base64AesKey) {
        return base64AesKey;
      }
      const status = response.data?.status || `HTTP ${response.status}`;
      throw Object.assign(
        new Error(`SAS rejected enterprise decryption for ${appName}: ${status}`),
        { sasRejected: true },
      );
    } catch (error) {
      lastError = error;
      if (error.sasRejected) {
        throw error;
      }
      const detail = error.response?.data?.message || error.response?.data?.status
        || error.message;
      log.warn(`Unable to contact SAS to decrypt ${appName} (attempt ${attempt}/${sasConfig.retryAttempts}): ${detail}`);
      if (attempt < sasConfig.retryAttempts) {
        // eslint-disable-next-line no-await-in-loop
        await wait(sasConfig.retryDelayMs);
      }
    }
  }

  throw new Error(`Unable to contact SAS to decrypt ${appName} after ${sasConfig.retryAttempts} attempts: ${lastError?.message || 'unknown error'}`);
}

function decryptAesData(appName, nonceCiphertextTag, base64AesKey) {
  try {
    const key = Buffer.from(base64AesKey, 'base64');
    if (key.length !== 32) {
      throw new Error(`SAS returned an invalid AES key length (${key.length} bytes)`);
    }
    const nonce = nonceCiphertextTag.subarray(0, ENTERPRISE_NONCE_BYTES);
    const ciphertext = nonceCiphertextTag.subarray(
      ENTERPRISE_NONCE_BYTES,
      -ENTERPRISE_AUTH_TAG_BYTES,
    );
    const authTag = nonceCiphertextTag.subarray(-ENTERPRISE_AUTH_TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    throw new Error(`Failed to decrypt enterprise payload for ${appName}: ${error.message}`);
  }
}

async function decryptEnterpriseSpecWithSas(spec, options = {}) {
  if (!isEnterpriseApp(spec)) {
    throw new Error(`App ${spec?.name || 'unknown'} is not an enterprise spec`);
  }
  const cached = getCachedDecryption(spec.hash);
  if (cached) return cached;
  if (!spec.owner) throw new Error(`Enterprise app ${spec.name} has no owner`);

  const enterpriseBuffer = Buffer.from(spec.enterprise, 'base64');
  const minimumLength = ENTERPRISE_RSA_KEY_BYTES
    + ENTERPRISE_NONCE_BYTES + ENTERPRISE_AUTH_TAG_BYTES + 1;
  if (enterpriseBuffer.length < minimumLength) {
    throw new Error(`Enterprise payload for ${spec.name} is too short (${enterpriseBuffer.length} bytes)`);
  }
  const encryptedAesKey = enterpriseBuffer.subarray(0, ENTERPRISE_RSA_KEY_BYTES);
  const encryptedPayload = enterpriseBuffer.subarray(ENTERPRISE_RSA_KEY_BYTES);
  const base64AesKey = await decryptAesKeyViaSas(
    spec.name,
    spec.owner,
    encryptedAesKey,
    options,
  );
  const plaintext = decryptAesData(spec.name, encryptedPayload, base64AesKey);
  const parsed = parseJson(plaintext);
  if (!parsed) throw new Error(`Decrypted enterprise payload for ${spec.name} is not valid JSON`);
  const content = hydrate(parsed);
  cacheDecryption(spec.hash, content);
  return content;
}

function clearCaches() {
  decryptedSpecsCache.clear();
  sasRuntimePromise = null;
}

function isSyncthingContainerData(containerData) {
  return typeof containerData === 'string'
    && (containerData.startsWith('s:')
      || containerData.startsWith('r:')
      || containerData.startsWith('g:'));
}

function getComponentNamesFromSpec(spec) {
  if (!spec) return [];

  if (Array.isArray(spec.compose) && spec.compose.length > 0) {
    return spec.compose.map((component) => component.name || 'unnamed-component');
  }

  if (spec.containerData !== undefined) {
    return ['main'];
  }

  return [];
}

function getRepotagsFromSpec(spec) {
  if (!spec || !Array.isArray(spec.compose)) return [];
  return spec.compose.map((component) => component?.repotag || '');
}

function hasSyncthingInSpec(spec) {
  if (!spec) return false;

  if (Array.isArray(spec.compose) && spec.compose.length > 0) {
    return spec.compose.some((component) => isSyncthingContainerData(component.containerData));
  }

  return isSyncthingContainerData(spec.containerData);
}

function getSyncthingAppInfo(spec) {
  const componentNames = getComponentNamesFromSpec(spec);
  const syncthingComponents = [];

  if (Array.isArray(spec.compose) && spec.compose.length > 0) {
    spec.compose.forEach((component) => {
      if (isSyncthingContainerData(component.containerData)) {
        syncthingComponents.push(component.name || 'unnamed-component');
      }
    });
  } else if (isSyncthingContainerData(spec.containerData)) {
    syncthingComponents.push('main');
  }

  return {
    appName: spec.name,
    componentNames,
    syncthingComponents,
    hasSyncthing: syncthingComponents.length > 0,
  };
}

function buildSyncthingAppEntry(spec) {
  const syncthingInfo = getSyncthingAppInfo(spec);
  if (!syncthingInfo.hasSyncthing) {
    return null;
  }

  return {
    appName: spec.name,
    componentNames: syncthingInfo.componentNames,
    repotags: getRepotagsFromSpec(spec),
  };
}

module.exports = {
  FLUX_API,
  isEnterpriseApp,
  isSyncthingContainerData,
  getComponentNamesFromSpec,
  getRepotagsFromSpec,
  hasSyncthingInSpec,
  getSyncthingAppInfo,
  buildSyncthingAppEntry,
  getSasConfiguration,
  createSasHttpsAgent,
  assertSasConfigured,
  decryptAesKeyViaSas,
  decryptAesData,
  decryptEnterpriseSpecWithSas,
  clearCaches,
};
