'use strict';
/**
 * Reviewer Agent — rule-based dedup and enrichment (no external AI required).
 *
 * Responsibilities:
 *  1. Remove duplicate or near-duplicate test cases (Levenshtein similarity ≥ 0.85)
 *  2. Ensure every test case has ≥ 3 steps
 *  3. Ensure every test case has a non-empty `expected` result
 *  4. Normalise `priority` to one of: High | Normal | Low
 *  5. Ensure `tags` is an array of lowercase strings
 */

const { logDecision } = require("./agentDecisionLog");
const { validateReviewerOutput, sanitizeReviewerOutput } = require("../core/schemas");
const logger = require("../utils/logger");

const VALID_PRIORITIES = new Set(["High", "Normal", "Low"]);

// ── Levenshtein distance ──────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / maxLen;
}

// ── Enrichment helpers ────────────────────────────────────────────────
function normalise(tc) {
  // Steps: must be an array of strings with at least 3 entries
  if (!Array.isArray(tc.steps) || tc.steps.length < 3) {
    tc.steps = Array.isArray(tc.steps) ? [...tc.steps] : [];
    while (tc.steps.length < 3) {
      tc.steps.push(`Step ${tc.steps.length + 1}: execute the test action`);
    }
  }

  // Expected: must be a non-empty string
  if (!tc.expected || typeof tc.expected !== "string" || tc.expected.trim() === "") {
    tc.expected = "The operation completes successfully without errors.";
  }

  // Priority: must be High, Normal, or Low
  if (!VALID_PRIORITIES.has(tc.priority)) {
    tc.priority = "Normal";
  }

  // Tags: must be an array of lowercase strings
  if (!Array.isArray(tc.tags)) {
    tc.tags = typeof tc.tags === "string" ? [tc.tags.toLowerCase()] : [];
  } else {
    tc.tags = tc.tags.map(t => String(t).toLowerCase());
  }

  return tc;
}

// ── Main review function ──────────────────────────────────────────────
async function review(testCases) {
  const inputCount = Array.isArray(testCases) ? testCases.length : 0;
  if (!testCases || testCases.length === 0) {
    logDecision('reviewer', { inputCount }, { outputCount: 0, removedDuplicates: 0 }, { note: 'empty input' });
    return testCases;
  }

  const SIMILARITY_THRESHOLD = 0.85;
  const reviewed = [];
  let removedDuplicates = 0;

  for (const tc of testCases) {
    const enriched = normalise({ ...tc });
    const isDuplicate = reviewed.some(
      kept => similarity(kept.title, enriched.title) >= SIMILARITY_THRESHOLD
    );
    if (!isDuplicate) {
      reviewed.push(enriched);
    } else {
      removedDuplicates++;
    }
  }

  let output = reviewed;
  const { valid, errors } = validateReviewerOutput(output);
  if (!valid) {
    logger.warn(`Reviewer output failed schema validation: ${errors.slice(0, 5).join('; ')} — sanitising`);
    output = sanitizeReviewerOutput(output);
  }

  logDecision('reviewer', { inputCount }, {
    outputCount: output.length,
    removedDuplicates
  }, { similarityThreshold: SIMILARITY_THRESHOLD });

  return output;
}

module.exports = { review };
