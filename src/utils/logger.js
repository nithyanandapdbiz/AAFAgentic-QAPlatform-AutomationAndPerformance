'use strict';
/**
 * logger.js — Winston logger with size-based rotation + age-based cleanup.
 *
 * Uses Winston's native `maxsize` + `maxFiles` rotation (no extra deps).
 * On startup, purges logs older than LOG_MAX_AGE_DAYS.
 *
 * Env vars:
 *   LOG_LEVEL          (default 'info')
 *   LOG_DIR            (default 'logs')
 *   LOG_MAX_SIZE_BYTES (default 20000000)
 *   LOG_MAX_FILES      (default 5)
 *   LOG_MAX_AGE_DAYS   (default 14)
 */
const fs      = require('fs');
const path    = require('path');
const winston = require('winston');

const LOG_DIR   = process.env.LOG_DIR || 'logs';
const LEVEL     = process.env.LOG_LEVEL || 'info';
const MAX_SIZE  = parseInt(process.env.LOG_MAX_SIZE_BYTES || '20000000', 10);
const MAX_FILES = parseInt(process.env.LOG_MAX_FILES      || '5',        10);
const MAX_AGE   = parseInt(process.env.LOG_MAX_AGE_DAYS   || '14',       10);

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Age-based cleanup (runs once at startup; cheap, bounded to logs/ only).
(function cleanupOldLogs() {
  try {
    const cutoff = Date.now() - (MAX_AGE * 86_400_000);
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!/\.(log|rot|log\.\d+)$/.test(f)) continue;
      const full = path.join(LOG_DIR, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch (_e) { /* per-file best-effort */ }
    }
  } catch (_e) { /* best-effort */ }
})();

module.exports = winston.createLogger({
  level: LEVEL,
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple())
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: MAX_SIZE,
      maxFiles: MAX_FILES,
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'app.log'),
      maxsize: MAX_SIZE,
      maxFiles: MAX_FILES,
      tailable: true,
    }),
  ],
});
