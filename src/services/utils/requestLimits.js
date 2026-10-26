const rateLimit = require('express-rate-limit');

function createLimiter(limit) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Use the socket peer, never client-supplied forwarding headers. A proxy
    // shares this budget unless Express proxy trust is explicitly configured.
    validate: { xForwardedForHeader: false },
    message: { status: 'error', data: { message: 'Too many requests; try again later' } },
  });
}

module.exports = {
  apiLimiter: createLimiter(600),
  loginLimiter: createLimiter(30),
  mutationLimiter: createLimiter(60),
};
