const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const qs = require('qs');
const zeltrezjs = require('zeltrezjs');
const bitcoinMessage = require('bitcoinjs-message');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const FLUX_API = 'https://api.runonflux.io';
const ARCANE_NODES_URL = 'https://stats.runonflux.io/fluxinfo?projection=flux';
const ARCANE_NODE_RETRY_COUNT = 3;

function ipPortToNodeBase(ipPort) {
  const [ip, port] = ipPort.split(':');
  return `https://${ip.replace(/\./g, '-')}-${port}.node.api.runonflux.io`;
}

function isEnterpriseApp(spec) {
  return !!(spec && spec.version >= 8 && spec.enterprise);
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

async function fetchArcaneNodeIpPorts() {
  const response = await axios.get(ARCANE_NODES_URL, {
    httpsAgent,
    timeout: 60000,
  });

  if (!response.data?.data || !Array.isArray(response.data.data)) {
    throw new Error('Unexpected response from ArcaneOS node list');
  }

  return response.data.data
    .filter((entry) => entry.flux?.arcaneVersion && entry.flux?.ip)
    .map((entry) => entry.flux.ip);
}

async function getArcaneNodeBaseUrls() {
  const ipPorts = await fetchArcaneNodeIpPorts();
  return ipPorts.map(ipPortToNodeBase);
}

function pickRandomItems(items, count) {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

async function pickArcaneNodeBaseUrls(count = ARCANE_NODE_RETRY_COUNT) {
  const nodeUrls = await getArcaneNodeBaseUrls();
  if (!nodeUrls.length) {
    throw new Error('No ArcaneOS nodes available');
  }
  return pickRandomItems(nodeUrls, count);
}

async function loginToArcaneNode(nodeBase, teamFluxID, teamPK) {
  const loginPhraseResponse = await axios.get(`${nodeBase}/id/loginphrase`, {
    httpsAgent,
    timeout: 20000,
  });
  const loginPhrase = loginPhraseResponse.data?.data;
  if (!loginPhrase) {
    throw new Error(`Failed to get login phrase from ${nodeBase}`);
  }

  let privateKey = teamPK;
  if (privateKey.length !== 64) {
    privateKey = zeltrezjs.address.WIFToPrivKey(privateKey);
  }

  const signature = bitcoinMessage.sign(
    loginPhrase,
    Buffer.from(privateKey, 'hex'),
    true,
  ).toString('base64');

  const loginInfo = {
    zelid: teamFluxID,
    signature,
    loginPhrase,
  };

  const verifyResponse = await axios.post(
    `${nodeBase}/id/verifylogin`,
    qs.stringify(loginInfo),
    { httpsAgent, timeout: 20000 },
  );

  if (verifyResponse.data?.status !== 'success') {
    throw new Error(`Failed to authenticate with ArcaneOS node ${nodeBase}`);
  }

  return qs.stringify(loginInfo);
}

async function createArcaneNodeSessions(teamFluxID, teamPK, nodeCount = ARCANE_NODE_RETRY_COUNT) {
  const nodeBases = await pickArcaneNodeBaseUrls(nodeCount);
  const sessions = [];

  for (let i = 0; i < nodeBases.length; i += 1) {
    const nodeBase = nodeBases[i];
    const zelidauth = await loginToArcaneNode(nodeBase, teamFluxID, teamPK);
    sessions.push({ nodeBase, zelidauth });
  }

  return sessions;
}

async function decryptEnterpriseSpecWithRetry(spec, nodeSessions) {
  if (!nodeSessions?.length) {
    throw new Error('No ArcaneOS node sessions available for enterprise decryption');
  }

  let lastError = null;

  for (let i = 0; i < nodeSessions.length; i += 1) {
    const { nodeBase, zelidauth } = nodeSessions[i];
    try {
      return await decryptEnterpriseSpecOnNode(nodeBase, spec, zelidauth);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Failed to decrypt enterprise spec for ${spec.name}`);
}

function buildSyncthingAppEntry(spec) {
  const syncthingInfo = getSyncthingAppInfo(spec);
  if (!syncthingInfo.hasSyncthing) {
    return null;
  }

  return {
    appName: spec.name,
    componentNames: syncthingInfo.componentNames,
  };
}

async function getAppOriginalOwner(appname, fallbackOwner) {
  try {
    const response = await axios.get(
      `${FLUX_API}/apps/apporiginalowner/${encodeURIComponent(appname)}`,
      { httpsAgent, timeout: 20000 },
    );
    if (response.data?.status === 'success' && response.data.data) {
      return response.data.data;
    }
  } catch {
    // fall back to spec owner
  }
  return fallbackOwner;
}

async function decryptEnterpriseSpecOnNode(nodeBase, spec, zelidauth) {
  if (!isEnterpriseApp(spec)) {
    throw new Error(`App ${spec.name} is not an enterprise spec`);
  }

  const owner = await getAppOriginalOwner(spec.name, spec.owner);

  const publicKeyResponse = await axios.post(
    `${nodeBase}/apps/getpublickey`,
    qs.stringify({ name: spec.name, owner }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        zelidauth,
      },
      httpsAgent,
      timeout: 60000,
    },
  );

  if (publicKeyResponse.data?.status !== 'success' || !publicKeyResponse.data.data) {
    throw new Error(`getpublickey failed for ${spec.name}: ${publicKeyResponse.data?.data || publicKeyResponse.data?.status}`);
  }

  const pubKeyDer = Buffer.from(
    publicKeyResponse.data.data.trim().replace(/\s+/g, ''),
    'base64',
  );
  const rsaKey = crypto.createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
  const aesKeyBytes = crypto.randomBytes(32);
  const encryptedAesKey = crypto.publicEncrypt(
    {
      key: rsaKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(aesKeyBytes.toString('base64')),
  );

  const specResponse = await axios.get(
    `${nodeBase}/apps/appspecifications/${encodeURIComponent(spec.name)}/true`,
    {
      headers: {
        zelidauth,
        'enterprise-key': encryptedAesKey.toString('base64'),
      },
      httpsAgent,
      timeout: 120000,
    },
  );

  if (specResponse.data?.status !== 'success' || !specResponse.data.data?.enterprise) {
    const reason = specResponse.data?.data?.message || specResponse.data?.status || 'unknown error';
    throw new Error(`appspecifications/true failed for ${spec.name}: ${reason}`);
  }

  const encryptedBuffer = Buffer.from(specResponse.data.data.enterprise, 'base64');
  const nonce = encryptedBuffer.subarray(0, 12);
  const ciphertextTag = encryptedBuffer.subarray(12);
  const ciphertext = ciphertextTag.subarray(0, ciphertextTag.length - 16);
  const authTag = ciphertextTag.subarray(ciphertextTag.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKeyBytes, nonce);
  decipher.setAuthTag(authTag);
  const plainText = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');

  return JSON.parse(plainText);
}

module.exports = {
  FLUX_API,
  ARCANE_NODES_URL,
  ARCANE_NODE_RETRY_COUNT,
  ipPortToNodeBase,
  isEnterpriseApp,
  isSyncthingContainerData,
  getComponentNamesFromSpec,
  hasSyncthingInSpec,
  getSyncthingAppInfo,
  buildSyncthingAppEntry,
  fetchArcaneNodeIpPorts,
  getArcaneNodeBaseUrls,
  pickArcaneNodeBaseUrls,
  loginToArcaneNode,
  createArcaneNodeSessions,
  getAppOriginalOwner,
  decryptEnterpriseSpecOnNode,
  decryptEnterpriseSpecWithRetry,
};
