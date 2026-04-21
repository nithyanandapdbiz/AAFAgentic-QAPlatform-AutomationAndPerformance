'use strict';
/**
 * rateLimiter.js — In-memory sliding-window rate limiter (per IP).
 *
 * Zero external dependencies. Keyed by X-Forwarded-For (first hop) or req.ip.
 * Evicts stale entries on every request to avoid unbounded memory growth.
 *
 * Config (read once at module load):
 *   RATE_LIMIT_WINDOW_MS  (default 60000)
 *   RATE_LIMIT_MAX        (default 100)
 */
const logger = require('../../utils/logger');

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const MAX_REQ   = parseInt(process.env.RATE_LIMIT_MAX       || '100',   10);

/** @type {Map<string, number[]>} ip → array of timestamps (ms) */
const hits = new Map();

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function rateLimiter(req, res, next) {
  const ip  = clientIp(req);
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  const recent = (hits.get(ip) || []).filter(t => t >= cutoff);
  recent.push(now);
  hits.set(ip, recent);

  // Evict any IP whose latest hit is already stale (bounded memory).
  if (hits.size > 10_000) {
    for (const [k, arr] of hits) {
      if (arr[arr.length - 1] < cutoff) hits.delete(k);
    }
  }

  if (recent.length > MAX_REQ) {
    const oldest = recent[0];
    const retryAfterMs = Math.max(0, WINDOW_MS - (now - oldest));
    logger.warn(`rate-limited ip=${ip} endpoint=${req.method} ${req.originalUrl} count=${recent.length}`);
    res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
    return res.status(429).json({ error: 'Too many requests', retryAfterMs });
  }

  next();
}

module.exports = { rateLimiter, _hits: hits };
