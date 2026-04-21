'use strict';
/**
 * Risk Prioritizer Agent — multi-factor risk-based test case prioritization.
 *
 * Scores each test case on three dimensions using weighted heuristic analysis:
 *   1. Business Impact   (1–10) — how critical is the feature being tested?
 *   2. Failure Likelihood (1–10) — based on complexity, integrations, edge-cases
 *   3. Defect Severity    (1–10) — if this fails, how severe is the defect?
 *
 * The composite risk score determines execution order: highest-risk tests run first.
 *
 * No external API dependencies — uses multi-layer tag/keyword/context analysis.
 */
const logger = require("../utils/logger");
const { logDecision } = require("./agentDecisionLog");
const { validateRiskPrioritizerOutput, sanitizeRiskPrioritizerOutput } = require("../core/schemas");

// ── Scoring weights and tag → dimension mappings ─────────────────────
const PRIORITY_BASE = { High: 8, Normal: 5, Low: 3 };

// Tags that signal high business impact (user-facing, data, security)
const BUSINESS_IMPACT_MAP = {
  10: ["security", "rbac", "authorization", "data-integrity", "persistence"],
   9: ["happy-path", "smoke", "acceptance-criteria"],
   8: ["regression", "validation"],
   6: ["negative", "duplicate"],
   5: ["boundary", "edge-case"],
   4: ["ui", "usability", "use-case"],
   3: ["cancel", "performance", "clipboard-paste"],
   2: ["browser-navigation", "network-resilience"]
};

// Tags that signal high failure likelihood (complex, edge, error-prone areas)
const FAILURE_LIKELIHOOD_MAP = {
  10: ["concurrency", "network-resilience"],
   9: ["edge-case", "special-characters", "unicode", "boundary", "bva"],
   8: ["error-guessing", "security", "injection"],
   7: ["negative", "invalid-data", "duplicate"],
   6: ["state-transition", "browser-navigation"],
   5: ["validation", "required-fields"],
   4: ["happy-path", "smoke"],
   3: ["ui", "feedback", "use-case"]
};

// Tags that signal high defect severity (what happens if this test fails?)
const SEVERITY_MAP = {
  10: ["security", "rbac", "authorization", "data-integrity"],
   9: ["persistence", "regression", "acceptance-criteria"],
   8: ["happy-path", "smoke"],
   7: ["negative", "validation", "duplicate"],
   6: ["boundary", "edge-case", "concurrency"],
   5: ["special-characters", "unicode"],
   4: ["state-transition", "cancel"],
   3: ["ui", "usability", "performance", "accessibility"]
};

// Story-context keywords that boost specific dimensions
const CONTEXT_BOOSTERS = [
  { pattern: /login|auth|password|session/i, businessBoost: 2, severityBoost: 2, reason: "authentication flow — high business + severity" },
  { pattern: /payment|transaction|financial/i, businessBoost: 3, severityBoost: 3, reason: "financial operation — critical business + severity" },
  { pattern: /delete|remove|deactivate/i,     businessBoost: 1, severityBoost: 2, reason: "destructive operation — elevated severity" },
  { pattern: /admin|role|permission/i,         businessBoost: 1, severityBoost: 2, reason: "access control — elevated severity" },
  { pattern: /upload|import|file/i,            businessBoost: 0, severityBoost: 1, reason: "file handling — slight severity bump" },
  { pattern: /employee|pim|personnel|hr/i,     businessBoost: 1, severityBoost: 0, reason: "HR data — slight business impact bump" }
];

/** Look up the highest score a test case earns from any of its tags in a dimension map */
function dimensionScore(tags, dimensionMap) {
  let best = 0;
  for (const [score, tagList] of Object.entries(dimensionMap)) {
    if (tags.some(t => tagList.includes(t))) {
      best = Math.max(best, Number(score));
    }
  }
  return best;
}

function scoreTestCase(tc, storyText) {
  const tags = (tc.tags || []).map(t => String(t).toLowerCase());
  const basePriority = PRIORITY_BASE[tc.priority] || 5;

  // Dimension scores from tag analysis
  let businessImpact    = dimensionScore(tags, BUSINESS_IMPACT_MAP) || basePriority;
  let failureLikelihood = dimensionScore(tags, FAILURE_LIKELIHOOD_MAP) || Math.round(basePriority * 0.8);
  let defectSeverity    = dimensionScore(tags, SEVERITY_MAP) || Math.round(basePriority * 0.9);

  // Context-aware boosting from story text
  let reasoning = `Priority: ${tc.priority}`;
  for (const booster of CONTEXT_BOOSTERS) {
    if (booster.pattern.test(storyText)) {
      businessImpact    = Math.min(businessImpact + booster.businessBoost, 10);
      defectSeverity    = Math.min(defectSeverity + booster.severityBoost, 10);
      reasoning = booster.reason;
    }
  }

  // Step-count complexity: more steps → slightly higher failure likelihood
  const stepCount = (tc.steps || []).length;
  if (stepCount > 8 )  failureLikelihood = Math.min(failureLikelihood + 1, 10);
  if (stepCount > 12)  failureLikelihood = Math.min(failureLikelihood + 1, 10);

  // Dynamic-generated tests fill gaps — slight likelihood bump
  if (tags.includes("dynamic-generated")) failureLikelihood = Math.min(failureLikelihood + 1, 10);

  // Composite: weighted average
  const compositeRisk = Math.round(
    businessImpact * 0.4 + failureLikelihood * 0.3 + defectSeverity * 0.3
  );

  return {
    businessImpact:    Math.min(businessImpact, 10),
    failureLikelihood: Math.min(failureLikelihood, 10),
    defectSeverity:    Math.min(defectSeverity, 10),
    compositeRisk:     Math.min(compositeRisk, 10),
    reasoning
  };
}

async function prioritize(testCases, story) {
  const inputCount = Array.isArray(testCases) ? testCases.length : 0;
  if (!testCases || testCases.length === 0) {
    logDecision('riskPrioritizer', { inputCount, storyKey: story?.key || null }, { outputCount: 0 }, { note: 'empty input' });
    return testCases;
  }

  const fields = story?.fields || {};
  const summary = fields.summary || "";
  const description = fields.description
    ? (typeof fields.description === "string" ? fields.description : JSON.stringify(fields.description))
    : "";
  const storyText = `${summary} ${description}`.toLowerCase();

  // Score each test case
  const scored = testCases.map(tc => ({
    ...tc,
    riskScore: scoreTestCase(tc, storyText)
  }));

  // Sort by composite risk descending — highest risk first
  scored.sort((a, b) => (b.riskScore.compositeRisk - a.riskScore.compositeRisk));

  // Update priority field based on risk score
  for (const tc of scored) {
    const cr = tc.riskScore.compositeRisk;
    if (cr >= 7)      tc.priority = "High";
    else if (cr >= 4) tc.priority = "Normal";
    else              tc.priority = "Low";
  }

  logger.info("Risk prioritization complete — test execution order:");
  scored.forEach((tc, i) => {
    logger.info(`  ${i + 1}. [Risk: ${tc.riskScore.compositeRisk}/10] ${tc.title} — ${tc.riskScore.reasoning}`);
  });

  let output = scored;
  const { valid, errors } = validateRiskPrioritizerOutput(output);
  if (!valid) {
    logger.warn(`RiskPrioritizer output failed schema validation: ${errors.slice(0, 5).join('; ')} — sanitising`);
    output = sanitizeRiskPrioritizerOutput(output);
  }

  const priorityCount = output.reduce((acc, tc) => {
    acc[tc.priority] = (acc[tc.priority] || 0) + 1; return acc;
  }, {});
  logDecision('riskPrioritizer', {
    inputCount,
    storyKey: story?.key || null
  }, {
    outputCount: output.length,
    priorityCount,
    topRisk: output[0] ? output[0].riskScore.compositeRisk : 0
  }, {
    top3: output.slice(0, 3).map(tc => ({ title: tc.title, compositeRisk: tc.riskScore.compositeRisk }))
  });

  return output;
}

module.exports = { prioritize };
