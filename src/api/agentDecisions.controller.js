'use strict';
/**
 * GET /agent-decisions — Observability endpoint exposing recent agent decisions.
 *
 * Query params:
 *   • limit     (number, 1..200; default 50)
 *   • agentName (string, optional; filters by agent)
 *
 * Responses:
 *   200 { total: number, entries: DecisionEntry[] }
 *   400 on invalid params
 */

const { readDecisions } = require('../agents/agentDecisionLog');

async function getAgentDecisions(req, res, next) {
  try {
    const rawLimit = req.query.limit;
    const rawAgent = req.query.agentName;

    let limit = 50;
    if (rawLimit !== undefined) {
      const n = parseInt(rawLimit, 10);
      if (!Number.isFinite(n) || n < 1 || n > 200) {
        return res.status(400).json({ error: 'limit must be an integer in [1, 200]' });
      }
      limit = n;
    }

    const agentName = (typeof rawAgent === 'string' && rawAgent.trim().length > 0)
      ? rawAgent.trim()
      : null;

    const entries = readDecisions({ limit, agentName });
    return res.json({ total: entries.length, entries });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getAgentDecisions };
