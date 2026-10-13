const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const signatureVerifier = require('./utils/signatureVerifier');
const secrets = require('../../secrets');

const challenges = new Map();
const sessions = new Map();
const challengeLifetime = 5 * 60 * 1000;
const sessionLifetime = 8 * 60 * 60 * 1000;
const cookieName = 'flux_admin_session';
const secureCookies = process.env.ADMIN_COOKIE_SECURE !== 'false';

function allowedAddresses() {
  const configured = secrets.adminAddresses;
  return Array.isArray(configured) ? configured.filter((value) => typeof value === 'string') : [];
}

function isAllowed(address) {
  return allowedAddresses().some((entry) => (
    address.startsWith('0x') && entry.startsWith('0x')
      ? entry.toLowerCase() === address.toLowerCase()
      : entry === address
  ));
}

function prune() {
  const now = Date.now();
  challenges.forEach((value, key) => { if (value.expires <= now) challenges.delete(key); });
  sessions.forEach((value, key) => { if (value.expires <= now) sessions.delete(key); });
}

function cookie(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)flux_admin_session=([a-f0-9]{64})(?:;|$)/);
  return match ? match[1] : null;
}

function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.host === req.get('host') && ['http:', 'https:'].includes(url.protocol)
      && (url.protocol === 'https:' || !secureCookies);
  } catch (error) {
    return false;
  }
}

function requireOrigin(req, res, next) {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Invalid request origin' });
  return next();
}

function requireAdmin(req, res, next) {
  prune();
  const session = sessions.get(cookie(req));
  if (!session || !isAllowed(session.address)) return res.status(401).json({ error: 'Please log in' });
  req.adminAddress = session.address;
  return next();
}

function requireAdminPage(req, res, next) {
  prune();
  const session = sessions.get(cookie(req));
  if (!session || !isAllowed(session.address)) return res.redirect('/admin/login.html');
  return next();
}

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
});
const walletStatusLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false,
});

function issueChallenge(req, res) {
  prune();
  if (challenges.size >= 1000) return res.status(429).json({ error: 'Too many pending sign-ins' });
  const id = crypto.randomBytes(24).toString('hex');
  const pollToken = crypto.randomBytes(24).toString('hex');
  const expires = Date.now() + challengeLifetime;
  const message = `Flux Backup Admin login\nHost: ${req.get('host')}\nNonce: ${id}\nExpires: ${new Date(expires).toISOString()}`;
  challenges.set(id, { message, expires, pollToken });
  return res.set('Cache-Control', 'no-store').json({
    id, message, expires, pollToken,
  });
}

function createSession(res, address) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { address, expires: Date.now() + sessionLifetime });
  res.cookie(cookieName, token, {
    httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/admin', maxAge: sessionLifetime,
  });
  return res.set('Cache-Control', 'no-store').json({ ok: true });
}

function login(req, res) {
  prune();
  const { id, address, signature } = req.body || {};
  if (typeof id !== 'string' || typeof address !== 'string' || typeof signature !== 'string'
    || id.length !== 48 || address.length > 128 || signature.length > 256) {
    return res.status(400).json({ error: 'Invalid login details' });
  }
  const challenge = challenges.get(id);
  challenges.delete(id);
  if (!challenge || challenge.expires <= Date.now() || !isAllowed(address)
    || !signatureVerifier.verifySignature(challenge.message, address, signature)) {
    return res.status(401).json({ error: 'Wallet signature or address was not accepted' });
  }
  return createSession(res, address);
}

function walletCallback(req, res) {
  prune();
  const message = req.body?.message || req.body?.loginPhrase;
  const signature = req.body?.signature;
  if (typeof message !== 'string' || typeof signature !== 'string' || message.length > 256 || signature.length > 256) {
    return res.status(400).send('Invalid signature');
  }
  const match = message.match(/\nNonce: ([a-f0-9]{48})\n/);
  const challenge = match && challenges.get(match[1]);
  if (!challenge || challenge.expires <= Date.now() || challenge.message !== message || challenge.approvedAddress) {
    return res.status(401).send('Invalid challenge');
  }
  const address = allowedAddresses().find((candidate) => signatureVerifier.verifySignature(message, candidate, signature));
  if (!address) return res.status(401).send('Wallet signature or address was not accepted');
  challenge.approvedAddress = address;
  return res.set('Cache-Control', 'no-store').send('OK');
}

function walletStatus(req, res) {
  prune();
  const { id, pollToken } = req.body || {};
  if (typeof id !== 'string' || typeof pollToken !== 'string') return res.status(400).json({ error: 'Invalid challenge' });
  const challenge = challenges.get(id);
  if (!challenge || challenge.pollToken !== pollToken) return res.status(401).json({ error: 'Challenge expired' });
  if (!challenge.approvedAddress) return res.set('Cache-Control', 'no-store').json({ ready: false });
  challenges.delete(id);
  return createSession(res, challenge.approvedAddress);
}

function logout(req, res) {
  sessions.delete(cookie(req));
  res.clearCookie(cookieName, {
    httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/admin',
  });
  res.set('Cache-Control', 'no-store').json({ ok: true });
}

module.exports = {
  issueChallenge,
  login,
  walletCallback,
  walletStatus,
  logout,
  requireAdmin,
  requireAdminPage,
  requireOrigin,
  loginLimiter,
  walletStatusLimiter,
};
