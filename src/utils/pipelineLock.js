'use strict';
/**
 * pipelineLock.js — File-based exclusive lock for single-pipeline-at-a-time enforcement.
 *
 * Uses fs.openSync(path, 'wx') for atomic create-or-fail semantics on POSIX
 * and Windows. Lock file contents: JSON { pid, issueKey, startedAt }.
 *
 * Safety:
 *   • Never throws — all errors are returned as { acquired: false, reason, error }.
 *   • Stale locks (dead pid OR age > timeout) are forcibly cleared with one retry.
 */
const fs   = require('fs');
const path = require('path');
const logger = require('./logger');
const { PreconditionError } = require('../core/errorHandler');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCK_FILE = path.join(ROOT, 'logs', '.pipeline.lock');
const DEFAULT_TIMEOUT_MS = parseInt(process.env.PIPELINE_LOCK_TIMEOUT_MS || '1800000', 10);

function ensureLogsDir() {
  const dir = path.dirname(LOCK_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); }
  catch (_e) { return null; }
}

function isAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM means process exists (other user)
}

function writeLock(issueKey) {
  ensureLogsDir();
  const fd = fs.openSync(LOCK_FILE, 'wx'); // atomic: throws EEXIST if present
  const payload = { pid: process.pid, issueKey: issueKey || null, startedAt: Date.now() };
  fs.writeSync(fd, JSON.stringify(payload));
  fs.closeSync(fd);
  return payload;
}

function acquireLock(issueKey, timeoutMs = DEFAULT_TIMEOUT_MS) {
  ensureLogsDir();
  try {
    const payload = writeLock(issueKey);
    return { acquired: true, lockPath: LOCK_FILE, payload };
  } catch (err) {
    if (err.code !== 'EEXIST') {
      return { acquired: false, reason: 'Lock write failed', error: err.message };
    }
    // Someone else holds it. Inspect.
    const incumbent = readLock();
    if (!incumbent) {
      // Corrupt/empty file — treat as stale.
      try { fs.unlinkSync(LOCK_FILE); } catch (_e) {}
      return retryOnce(issueKey);
    }
    const age = Date.now() - (incumbent.startedAt || 0);
    const alive = isAlive(incumbent.pid);
    if (!alive) {
      logger.warn(`pipelineLock: stale lock from dead pid ${incumbent.pid} — clearing`);
      try { fs.unlinkSync(LOCK_FILE); } catch (_e) {}
      return retryOnce(issueKey);
    }
    if (age > timeoutMs) {
      logger.warn(`pipelineLock: hung pipeline pid=${incumbent.pid} age=${age}ms > timeout=${timeoutMs}ms — clearing`);
      try { fs.unlinkSync(LOCK_FILE); } catch (_e) {}
      return retryOnce(issueKey);
    }
    return { acquired: false, reason: 'Pipeline already running', incumbent };
  }
}

function retryOnce(issueKey) {
  try {
    const payload = writeLock(issueKey);
    return { acquired: true, lockPath: LOCK_FILE, payload };
  } catch (err) {
    return { acquired: false, reason: 'Retry after stale-clear failed', error: err.message };
  }
}

function releaseLock() {
  try {
    const incumbent = readLock();
    if (!incumbent) return;
    if (incumbent.pid !== process.pid) {
      logger.warn(`pipelineLock: refusing to release lock owned by pid ${incumbent.pid} (we are ${process.pid})`);
      return;
    }
    fs.unlinkSync(LOCK_FILE);
    const duration = Date.now() - (incumbent.startedAt || Date.now());
    logger.info(`Pipeline lock released (held ${duration}ms)`);
  } catch (_e) { /* best-effort */ }
}

/**
 * Execute `fn` while holding the pipeline lock. Throws PreconditionError if
 * another pipeline is active.
 */
async function withLock(issueKey, fn) {
  const r = acquireLock(issueKey);
  if (!r.acquired) {
    const inc = r.incumbent || {};
    throw new PreconditionError(
      `Pipeline already running for ${inc.issueKey || 'unknown'} (pid ${inc.pid})`,
      {
        recoveryHint: `Wait for pipeline to complete or check pid ${inc.pid}. ` +
                      `Delete ${LOCK_FILE} manually only if the process is confirmed dead.`,
        details: inc
      }
    );
  }
  try { return await fn(); }
  finally { releaseLock(); }
}

// Auto-release on normal exit so tests / ad-hoc runs don't leave stale locks.
process.once('exit',  releaseLock);
process.once('SIGINT',  () => { releaseLock(); process.exit(130); });
process.once('SIGTERM', () => { releaseLock(); process.exit(143); });

module.exports = { acquireLock, releaseLock, withLock, LOCK_FILE, getActiveLock };

/**
 * Non-mutating inspection: returns the active lock payload if held by a live
 * process, otherwise null. Used by webhook/manual-trigger endpoints to decide
 * whether to reject a new request with 409 without opening/owning the lock.
 */
function getActiveLock() {
  if (!fs.existsSync(LOCK_FILE)) return null;
  const incumbent = readLock();
  if (!incumbent) return null;
  const age = Date.now() - (incumbent.startedAt || 0);
  if (!isAlive(incumbent.pid)) return null;
  if (age > DEFAULT_TIMEOUT_MS) return null;
  return incumbent;
}
