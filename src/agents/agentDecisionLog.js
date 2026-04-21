'use strict';
/**
 * agentDecisionLog — append-only, structured observability for rule-based agents.
 *
 * Each agent (planner, qa, reviewer, riskPrioritizer) calls `logDecision()` at
 * the end of its run. Entries are appended to logs/agent-decisions.json as a
 * JSON array. Readers may use the `/agent-decisions` REST endpoint.
 */

const fs   = require('fs');
const path = require('path');

const LOG_DIR  = path.resolve(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'agent-decisions.json');
const MAX_ENTRIES = 2000; // cap file to avoid unbounded growth

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) { /* ignore */ }
}

function readAll() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const raw = fs.readFileSync(LOG_FILE, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/**
 * Append a decision entry.
 *
 * @param {string} agentName - planner | qa | reviewer | riskPrioritizer | other
 * @param {object} input     - summary of agent input (story key, title, word count, ...)
 * @param {object} output    - summary of agent output (count, priorities, confidence, ...)
 * @param {object|string} reasoning - matched keywords, scores, notes
 */
function logDecision(agentName, input = {}, output = {}, reasoning = {}) {
  try {
    ensureDir();
    const entry = {
      timestamp: new Date().toISOString(),
      agentName: String(agentName || 'unknown'),
      input,
      output,
      reasoning,
    };
    const entries = readAll();
    entries.push(entry);
    // Trim from the head to preserve newest
    const trimmed = entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries;
    fs.writeFileSync(LOG_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (_) {
    // Never throw from the log path — observability must not break pipelines.
  }
}

function readDecisions({ limit = 50, agentName = null } = {}) {
  const entries = readAll();
  const filtered = agentName
    ? entries.filter(e => String(e.agentName).toLowerCase() === String(agentName).toLowerCase())
    : entries;
  const capped = Math.max(1, Math.min(200, Number(limit) || 50));
  return filtered.slice(-capped).reverse(); // newest first
}

module.exports = { logDecision, readDecisions, LOG_FILE };
