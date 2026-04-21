'use strict';
/**
 * authGuard.js — Bearer-token guard with constant-time comparison.
 *
 * Behaviour:
 *   • If API_SECRET is not set: pass-through (opt-in security, matches legacy).
 *   • If set: requires `Authorization: Bearer <token>` and compares in constant time.
 *   • On failure: logs a WARN (ip + endpoint, never the token) and returns 401.
 */
const crypto = require('crypto');
const logger = require('../../utils/logger');

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Length-safe constant-time string compare. Returns false for any length
 * mismatch WITHOUT revealing timing of the mismatch location.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Always call timingSafeEqual on equal-length buffers to avoid early-exit.
  if (ab.length !== bb.length) {
    // Dummy compare to approximately equalise timing.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function authGuard(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return next(); // opt-in

  const header = req.headers.authorization || '';
  const token  = header.replace(/^Bearer\s+/i, '');

  if (!safeEqual(token, secret)) {
    logger.warn(`auth-failure ip=${clientIp(req)} endpoint=${req.method} ${req.originalUrl}`);
    return res.status(401).json({ error: 'Unauthorised' });
  }
  next();
}

module.exports = { authGuard };
