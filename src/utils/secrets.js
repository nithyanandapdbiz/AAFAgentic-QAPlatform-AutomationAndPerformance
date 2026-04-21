'use strict';
/**
 * secrets.js — Provider-agnostic secrets resolver.
 *
 * Providers (selected via SECRETS_PROVIDER):
 *   • 'env'   (default)  → process.env[key]
 *   • 'vault'            → HashiCorp Vault KV v2 over HTTPS (VAULT_ADDR, VAULT_TOKEN, VAULT_SECRET_PATH)
 *   • 'aws'              → stubbed; throws a clear error
 *
 * Every successful resolution appends one line to logs/secret-access.log:
 *   { timestamp, key, provider, resolvedLength, pid }
 * The VALUE is never logged — not even a prefix, hash, or length-other-than-length.
 */
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_LOG = path.join(ROOT, 'logs', 'secret-access.log');

const PROVIDER = (process.env.SECRETS_PROVIDER || 'env').toLowerCase();
const _cache = new Map(); // key → resolved value (process-lifetime)
let _vaultKv = null;      // lazy-loaded vault snapshot

/** Append a single audit line. Failure MUST NOT break secret resolution. */
function audit(key, value) {
  try {
    const dir = path.dirname(AUDIT_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      key,
      provider: PROVIDER,
      resolvedLength: typeof value === 'string' ? value.length : 0,
      pid: process.pid,
    });
    fs.appendFileSync(AUDIT_LOG, entry + '\n');
  } catch (_e) { /* swallow — audit must not break startup */ }
}

function httpRequest(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: opts.method || 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: opts.headers || {},
      timeout: 10_000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function loadVaultKv() {
  if (_vaultKv) return _vaultKv;
  const addr  = process.env.VAULT_ADDR;
  const token = process.env.VAULT_TOKEN;
  const kvPath = process.env.VAULT_SECRET_PATH || 'secret/data/agentic-qa';
  if (!addr || !token) {
    throw new Error('VAULT_ADDR and VAULT_TOKEN must be set when SECRETS_PROVIDER=vault');
  }
  const url = `${addr.replace(/\/$/, '')}/v1/${kvPath}`;
  const { status, body } = await httpRequest(url, { headers: { 'X-Vault-Token': token } });
  if (status !== 200) throw new Error(`Vault read failed: HTTP ${status}`);
  const json = JSON.parse(body || '{}');
  _vaultKv = (json.data && json.data.data) || {};
  return _vaultKv;
}

/**
 * Resolve a secret by key.
 * @param {string} key
 * @returns {Promise<string>}
 */
async function getSecret(key) {
  if (_cache.has(key)) return _cache.get(key);

  let value;
  switch (PROVIDER) {
    case 'env':
      value = process.env[key];
      break;
    case 'vault': {
      const kv = await loadVaultKv();
      value = kv[key] || process.env[key]; // allow env fallback so non-sensitive keys still work
      break;
    }
    case 'aws':
      throw makePreconditionError(
        'AWS Secrets Manager provider not yet implemented. Set SECRETS_PROVIDER=env or vault.'
      );
    default:
      throw makePreconditionError(
        `Unknown SECRETS_PROVIDER='${PROVIDER}'. Valid: env | vault | aws.`
      );
  }

  if (!value || String(value).length === 0) {
    throw makePreconditionError(
      `Required secret '${key}' is not configured. Provider: ${PROVIDER}`
    );
  }

  _cache.set(key, String(value));
  audit(key, value);
  return String(value);
}

// Lazy import to break the circular dependency (errorHandler imports nothing from here,
// but keeping this lazy is defensive for future refactors).
function makePreconditionError(msg) {
  const { PreconditionError } = require('../core/errorHandler');
  return new PreconditionError(msg, {
    recoveryHint: 'Set the missing value in your secrets provider or .env and restart.'
  });
}

/** Test-only helper: drop cache so next getSecret() re-fetches. */
function _resetCache() { _cache.clear(); _vaultKv = null; }

module.exports = { getSecret, _resetCache, PROVIDER };
