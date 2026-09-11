const sessions = require('memory-cache');
const qs = require('qs');
const config = require('../../config/default');
const signatureVerifier = require('./utils/signatureVerifier');
const messageHelper = require('./utils/messageHelper');
const log = require('../lib/log');

const goodchars = /^[1-9a-km-zA-HJ-NP-Z]+$/;
const ethRegex = /^0x[a-fA-F0-9]{40}$/;
const sessionExpireTime = 1.5 * 60 * 60 * 1000;
const signatureValidationTime = 1.5 * 60 * 60 * 1000;

/**
 * To check if a parameter is an object and if not, return an empty object.
 * @param {*} parameter Parameter of any type.
 * @returns {object} Returns the original parameter if it is an object or returns an empty object.
 */
function ensureObject(parameter) {
  if (typeof parameter === 'object') {
    return parameter;
  }
  if (!parameter) {
    return {};
  }
  let param;
  try {
    param = JSON.parse(parameter);
  } catch (e) {
    param = qs.parse(parameter);
  }
  if (typeof param !== 'object') {
    return {};
  }
  return param;
}
/**
* [addNewSession]
*/
function addNewSession(sessionID, params) {
  // eslint-disable-next-line no-param-reassign
  if (!params) params = 'NA';
  sessions.put(sessionID, params, sessionExpireTime);
  log.info(`new session from ${JSON.stringify(params)}`);
  return sessionID;
}
/**
* [verifySession]
*/
function verifySession(sessionID, params) {
  // eslint-disable-next-line no-param-reassign
  const value = sessions.get(sessionID);
  // console.log(value);
  if (!value || value.signature !== params.signature) return false;
  sessions.put(sessionID, params, sessionExpireTime);
  return true;
}

/**
* [removeSession]
*/
function removeSession(sessionID) {
  log.info('session logged out.');
  sessions.del(sessionID);
  return true;
}
/**
 * To return a JSON response to show the user if they have logged in successfully or not. In order to successfully log in, a series of checks are performed on the ZelID and signature.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function readLoginBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (req.readableEnded) return ensureObject(req.body);

  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (data) => {
      body += data;
      if (body.length > 1024 * 1024) {
        const error = new Error('Login request body is too large');
        error.code = 'REQUEST_BODY_TOO_LARGE';
        reject(error);
        req.destroy();
      }
    });
    req.once('end', () => resolve(ensureObject(body)));
    req.once('error', reject);
    req.once('aborted', () => reject(new Error('Login request was aborted')));
  });
}

async function verifyLogin(req, res) {
  try {
    const processedBody = await readLoginBody(req);
    const address = processedBody.zelid || processedBody.address;
    const { signature } = processedBody;
    const message = processedBody.loginPhrase || processedBody.message;
    const timestamp = new Date().getTime();

    if (address === undefined || address === '') {
      throw new Error('No ZelID is specified');
    }
    if (address[0] !== '1' && address[0] !== '0') {
      throw new Error('ZelID is not valid');
    }
    if (address[0] === '1') {
      if (!goodchars.test(address) || address.length > 34 || address.length < 25) {
        throw new Error('ZelID is not valid');
      }
    } else if (!ethRegex.test(address)) {
      throw new Error('ZelID is not valid');
    }
    if (message === undefined || message === '' || message.length < 40) {
      throw new Error(message ? 'Signed message is not valid' : 'No message is specified');
    }
    if (+message.substring(0, 13) < (timestamp - signatureValidationTime)
      || +message.substring(0, 13) > timestamp) {
      throw new Error('Signed message is not valid');
    }
    if (signature === undefined || signature === '') {
      throw new Error('No signature is specified');
    }

    let valid = false;
    try {
      valid = signatureVerifier.verifySignature(message, address, signature);
    } catch (error) {
      throw new Error('Invalid signature');
    }
    if (!valid) throw new Error('Invalid signature');

    const newLogin = {
      zelid: address,
      loginPhrase: message,
      signature,
    };
    const privilage = address === config.fluxTeamZelId ? 'fluxteam' : 'user';
    addNewSession(message, newLogin);
    const resData = {
      message: 'Successfully logged in',
      zelid: address,
      loginPhrase: message,
      signature,
      privilage,
    };
    res.json(messageHelper.createDataMessage(resData));
  } catch (error) {
    log.error(error);
    if (!res.headersSent) {
      const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
      res.json(errMessage);
    }
  }
}

/**
 * Verifies user session
 * @param {object} headers
 *
 * @returns {Promise<boolean>}
 */
async function verifyUserSession(headers) {
  if (!headers || !headers.zelidauth) return false;
  const auth = ensureObject(headers.zelidauth);
  if (!auth.zelid || !auth.signature || !auth.loginPhrase) return false;

  const sessionParams = {
    zelid: auth.zelid,
    loginPhrase: auth.loginPhrase,
    signature: auth.signature,
  };

  const verify = verifySession(auth.loginPhrase, sessionParams);
  // log.debug(`verify ${JSON.stringify(sessionParams)}:${verify}`);
  if (verify) {
    try {
      if (signatureVerifier.verifySignature(auth.loginPhrase, auth.zelid, auth.signature) === true) return auth.zelid;
    } catch (error) {
      return false;
    }
  } else if (signatureVerifier.verifySignature(auth.loginPhrase, auth.zelid, auth.signature) === true) {
    const timestamp = new Date().getTime();
    if (+auth.loginPhrase.substring(0, 13) < (timestamp - signatureValidationTime) || +auth.loginPhrase.substring(0, 13) > timestamp) {
      return false;
    }
    return auth.zelid;
  }
  return false;
}

module.exports = {
  verifyLogin,
  verifySession,
  removeSession,
  addNewSession,
  verifyUserSession,
  testHooks: { readLoginBody },
};
