'use strict';
/**
 * Planner Agent — advanced rule-based with contextual NLP heuristics.
 * Analyses a Jira story's text to produce a structured test plan:
 * scope, testTypes, designTechniques, criticalScenarios, and risks.
 *
 * No external API dependencies — uses multi-layer keyword analysis,
 * contextual pattern matching, and domain-aware inference rules.
 *
 * Design Technique Selection:
 *   BVA  (Boundary Value Analysis)     — numeric fields, lengths, limits
 *   EP   (Equivalence Partitioning)    — input classes: valid / invalid / empty
 *   DT   (Decision Table)             — multiple condition combinations
 *   ST   (State Transition)           — multi-step flows, status changes
 *   EG   (Error Guessing)             — negative, security, edge cases
 *   UC   (Use Case / Scenario-based)  — end-to-end user journey tests
 */

const logger = require("../utils/logger");
const { logDecision } = require("./agentDecisionLog");
const { validatePlannerOutput, sanitizePlannerOutput } = require("../core/schemas");

// ── Weighted keyword registry ───────────────────────────────────────
// Each entry: { keyword, weight (1-3), category }. Higher weight = stronger signal.
// Categories align with test-type labels emitted in the plan.
const WEIGHTED_KEYWORDS = [
  // Happy Path (weight: strong verbs tied to the primary user action)
  { keyword: "create",    weight: 2, category: "Happy Path" },
  { keyword: "add",       weight: 2, category: "Happy Path" },
  { keyword: "submit",    weight: 2, category: "Happy Path" },
  { keyword: "save",      weight: 2, category: "Happy Path" },
  { keyword: "register",  weight: 2, category: "Happy Path" },
  { keyword: "complete",  weight: 1, category: "Happy Path" },
  { keyword: "update",    weight: 2, category: "Happy Path" },
  { keyword: "login",     weight: 3, category: "Happy Path" },
  { keyword: "upload",    weight: 2, category: "Happy Path" },

  // Negative (error-oriented words)
  { keyword: "error",     weight: 2, category: "Negative" },
  { keyword: "invalid",   weight: 3, category: "Negative" },
  { keyword: "reject",    weight: 3, category: "Negative" },
  { keyword: "deny",      weight: 2, category: "Negative" },
  { keyword: "fail",      weight: 2, category: "Negative" },
  { keyword: "missing",   weight: 2, category: "Negative" },
  { keyword: "prevent",   weight: 2, category: "Negative" },
  { keyword: "wrong",     weight: 1, category: "Negative" },

  // Edge Case
  { keyword: "empty",     weight: 2, category: "Edge Case" },
  { keyword: "null",      weight: 2, category: "Edge Case" },
  { keyword: "zero",      weight: 1, category: "Edge Case" },
  { keyword: "max",       weight: 2, category: "Edge Case" },
  { keyword: "min",       weight: 2, category: "Edge Case" },
  { keyword: "unicode",   weight: 3, category: "Edge Case" },
  { keyword: "special character", weight: 3, category: "Edge Case" },

  // UI Validation
  { keyword: "field",     weight: 1, category: "UI Validation" },
  { keyword: "form",      weight: 2, category: "UI Validation" },
  { keyword: "input",     weight: 1, category: "UI Validation" },
  { keyword: "button",    weight: 1, category: "UI Validation" },
  { keyword: "display",   weight: 1, category: "UI Validation" },
  { keyword: "screen",    weight: 1, category: "UI Validation" },
  { keyword: "label",     weight: 1, category: "UI Validation" },

  // Security
  { keyword: "password",  weight: 3, category: "Security" },
  { keyword: "auth",      weight: 3, category: "Security" },
  { keyword: "permission",weight: 3, category: "Security" },
  { keyword: "role",      weight: 2, category: "Security" },
  { keyword: "rbac",      weight: 3, category: "Security" },
  { keyword: "admin",     weight: 2, category: "Security" },
  { keyword: "token",     weight: 3, category: "Security" },
  { keyword: "injection", weight: 3, category: "Security" },
  { keyword: "xss",       weight: 3, category: "Security" },
  { keyword: "csrf",      weight: 3, category: "Security" },
  { keyword: "encryption",weight: 3, category: "Security" },
  { keyword: "session",   weight: 2, category: "Security" },
  { keyword: "owasp",     weight: 3, category: "Security" },

  // Boundary
  { keyword: "limit",     weight: 2, category: "Boundary" },
  { keyword: "length",    weight: 2, category: "Boundary" },
  { keyword: "range",     weight: 2, category: "Boundary" },
  { keyword: "size",      weight: 1, category: "Boundary" },
  { keyword: "boundary",  weight: 3, category: "Boundary" },
  { keyword: "character", weight: 1, category: "Boundary" },

  // Integration
  { keyword: "api",       weight: 2, category: "Integration" },
  { keyword: "webhook",   weight: 3, category: "Integration" },
  { keyword: "sync",      weight: 2, category: "Integration" },
  { keyword: "service",   weight: 1, category: "Integration" },
  { keyword: "external",  weight: 2, category: "Integration" },
  { keyword: "third",     weight: 2, category: "Integration" },
  { keyword: "notification", weight: 2, category: "Integration" },
  { keyword: "email",     weight: 1, category: "Integration" },

  // Performance
  { keyword: "load test", weight: 3, category: "performance" },
  { keyword: "stress test", weight: 3, category: "performance" },
  { keyword: "spike",     weight: 3, category: "performance" },
  { keyword: "soak",      weight: 3, category: "performance" },
  { keyword: "throughput",weight: 3, category: "performance" },
  { keyword: "latency",   weight: 3, category: "performance" },
  { keyword: "response time", weight: 3, category: "performance" },
  { keyword: "concurrent users", weight: 3, category: "performance" },
  { keyword: "sla",       weight: 2, category: "performance" },
  { keyword: "scalability", weight: 3, category: "performance" },
  { keyword: "performance", weight: 2, category: "performance" },
  { keyword: "benchmark", weight: 2, category: "performance" },

  // Security-scan (maps to ZAP signals)
  { keyword: "zap",       weight: 3, category: "security-scan" },
  { keyword: "vulnerability", weight: 3, category: "security-scan" },
  { keyword: "penetration", weight: 3, category: "security-scan" },
  { keyword: "pentest",   weight: 3, category: "security-scan" },
  { keyword: "sql injection", weight: 3, category: "security-scan" },
  { keyword: "broken auth", weight: 3, category: "security-scan" },
  { keyword: "ssrf",      weight: 3, category: "security-scan" },
  { keyword: "idor",      weight: 3, category: "security-scan" },
  { keyword: "security scan", weight: 3, category: "security-scan" },
  { keyword: "security audit", weight: 3, category: "security-scan" },

  // Security (functional aspects — distinct category expected by downstream code)
  { keyword: "authentication", weight: 3, category: "security" },
  { keyword: "authorisation",  weight: 3, category: "security" },
  { keyword: "authorization",  weight: 3, category: "security" },
  { keyword: "jwt",       weight: 3, category: "security" },
  { keyword: "cookie",    weight: 2, category: "security" },
  { keyword: "ssl",       weight: 2, category: "security" },
  { keyword: "tls",       weight: 2, category: "security" },
  { keyword: "security header", weight: 3, category: "security" },
];

// Legacy flat arrays kept for any external consumer / back-compat import.
const TYPE_SIGNALS = WEIGHTED_KEYWORDS.reduce((acc, { keyword, category }) => {
  (acc[category] = acc[category] || []).push(keyword);
  return acc;
}, {});

// Design technique selection based on story content
const TECHNIQUE_SIGNALS = {
  "Boundary Value Analysis": ["limit", "max", "min", "length", "count", "number", "size", "range", "character", "boundary"],
  "Equivalence Partitioning": ["valid", "invalid", "input", "data", "field", "form", "value", "enter"],
  "Decision Table":           ["if", "when", "condition", "combination", "multiple", "and", "or", "role", "permission"],
  "State Transition":         ["status", "state", "flow", "step", "wizard", "transition", "from", "to", "stage", "workflow"],
  "Error Guessing":           ["fail", "error", "invalid", "crash", "null", "empty", "special", "unicode", "overflow", "injection"],
  "Use Case / Scenario":      ["user", "as a", "so that", "scenario", "journey", "end-to-end", "complete"]
};

// Risk patterns detected from keywords
const RISK_SIGNALS = [
  { keyword: "delete",   risk: "Data loss on accidental deletion" },
  { keyword: "password", risk: "Password storage or transmission vulnerability" },
  { keyword: "upload",   risk: "Malicious file upload or oversized payload" },
  { keyword: "email",    risk: "Invalid email format or duplicate registration" },
  { keyword: "role",     risk: "Privilege escalation or unauthorized access" },
  { keyword: "payment",  risk: "Financial data integrity and transaction failure" },
  { keyword: "search",   risk: "Injection through search inputs" },
  { keyword: "import",   risk: "Corrupt or incompatible file format handling" },
  { keyword: "export",   risk: "Sensitive data leakage in exported files" }
];

/** Recursively extracts plain text from Atlassian Document Format or plain string */
function extractText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text || "";
  if (Array.isArray(node.content)) return node.content.map(extractText).join(" ");
  if (node.content) return extractText(node.content);
  return "";
}

function lower(text) { return (text || "").toLowerCase(); }

/**
 * Tokenise text into a clean whole-word array.
 * Strips punctuation by replacing it with spaces (NOT empty string), so
 * "auth," becomes "auth" and "oauth," becomes "oauth" — they remain distinct
 * tokens. This is the foundation of word-boundary keyword matching.
 * @param {string} text
 * @returns {string[]} lowercase whole-word tokens
 */
function tokenise(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")   // punctuation → space (preserves word boundaries)
    .split(/\s+/)
    .filter(t => t.length > 0);
}

/**
 * Word-boundary-safe keyword hit test.
 *   • single-word keyword → exact token-set membership (O(1))
 *   • multi-word phrase   → padded-substring on the normalised token stream
 * Prevents false positives like "load" matching inside "upload".
 * @param {string} keyword
 * @param {Set<string>} tokenSet
 * @param {string} paddedText  " tok1 tok2 tok3 " (leading+trailing space)
 * @returns {boolean}
 */
function keywordMatches(keyword, tokenSet, paddedText) {
  const kw = keyword.toLowerCase();
  if (kw.indexOf(" ") === -1) return tokenSet.has(kw);
  return paddedText.indexOf(` ${kw} `) !== -1;
}

async function plan(story) {
  const fields      = story.fields || {};
  const summary     = lower(fields.summary || "");
  const description = lower(extractText(fields.description));
  const ac          = lower(extractText(fields.customfield_10016) || extractText(fields.customfield_10014) || "");
  const allText     = `${summary} ${description} ${ac}`;

  // ── Word-boundary tokenisation (shared by all keyword lookups) ──
  const tokens     = tokenise(allText);
  const tokenSet   = new Set(tokens);
  const paddedText = ` ${tokens.join(" ")} `;

  // ── Weighted score aggregation per category ─────────────────────
  const categoryScores = {};
  const matchedKeywords = []; // for decision log

  for (const entry of WEIGHTED_KEYWORDS) {
    if (keywordMatches(entry.keyword, tokenSet, paddedText)) {
      const s = entry.weight;
      categoryScores[entry.category] = (categoryScores[entry.category] || 0) + s;
      matchedKeywords.push({ keyword: entry.keyword, weight: s, category: entry.category });
    }
  }

  // Score-to-confidence normalisation: max possible per category is unbounded; we scale
  // by the category's own top score so the strongest category is always 1.0.
  const scoreValues = Object.values(categoryScores);
  const topScore = scoreValues.length > 0 ? Math.max(...scoreValues) : 0;

  // A category is "selected" if its normalised confidence >= CONFIDENCE_THRESHOLD
  const confThreshold = parseFloat(
    process.env.AGENT_CONFIDENCE_THRESHOLD || '0.4'
  );

  const scoredCategories = Object.entries(categoryScores).map(([cat, s]) => ({
    category:   cat,
    score:      s,
    confidence: topScore > 0 ? +(s / topScore).toFixed(3) : 0
  }));
  scoredCategories.sort((a, b) => b.score - a.score);

  const testTypes = scoredCategories
    .filter(x => x.confidence >= confThreshold)
    .map(x => x.category);
  if (testTypes.length === 0) testTypes.push("Happy Path", "Negative");

  // Overall plan confidence: mean of top-3 confidences (or 0 if nothing matched)
  const topThree = scoredCategories.slice(0, 3);
  const overallConfidence = topThree.length > 0
    ? +((topThree.reduce((a, b) => a + b.confidence, 0) / topThree.length).toFixed(3))
    : 0;

  // ── Design techniques (word-boundary safe) ─────────────────────
  const designTechniques = Object.entries(TECHNIQUE_SIGNALS)
    .filter(([, keywords]) => keywords.some(k => keywordMatches(k, tokenSet, paddedText)))
    .map(([technique]) => technique);
  if (designTechniques.length === 0) designTechniques.push("Equivalence Partitioning", "Error Guessing");

  // ── Risks (word-boundary safe) ─────────────────────────────────
  const risks = RISK_SIGNALS
    .filter(r => keywordMatches(r.keyword, tokenSet, paddedText))
    .map(r => r.risk);

  const criticalScenarios = [
    `Verify successful ${fields.summary || "operation"} with valid data`,
    `Verify system handles invalid or missing data gracefully`,
    `Verify UI feedback (success/error messages) is correct`
  ];

  const augmented = augmentPlan(fields, allText, testTypes, designTechniques);
  for (const s of augmented.criticalScenarios) if (!criticalScenarios.includes(s)) criticalScenarios.push(s);
  for (const r of augmented.risks)            if (!risks.includes(r))            risks.push(r);
  for (const t of augmented.additionalTestTypes) if (!testTypes.includes(t))     testTypes.push(t);

  if (augmented.criticalScenarios.length + augmented.risks.length + augmented.additionalTestTypes.length > 0) {
    logger.info("Planner: contextual augmentation applied — additional insights merged into plan");
  }

  let output = {
    scope: `Test all aspects of: ${fields.summary || "story"}`,
    testTypes,
    designTechniques,
    criticalScenarios,
    risks: risks.length > 0 ? risks : ["Unexpected system behaviour with boundary inputs"],
    confidence: overallConfidence
  };

  // ── Schema validation (non-throwing: sanitise on failure) ──────
  const { valid, errors } = validatePlannerOutput(output);
  if (!valid) {
    logger.warn(`Planner output failed schema validation: ${errors.join('; ')} — sanitising`);
    output = sanitizePlannerOutput(output);
  }

  // ── Decision logging ──────────────────────────────────────────
  logDecision('planner', {
    storyKey:   story.key || fields.issuetype?.name || null,
    title:      fields.summary || null,
    wordCount:  allText.trim().split(/\s+/).length
  }, {
    testTypes,
    designTechniques,
    testTypeCount: testTypes.length,
    overallConfidence
  }, {
    matchedKeywords:   matchedKeywords.slice(0, 50),
    scoredCategories,
    confidenceThreshold: confThreshold
  });

  return output;
}

// ── Contextual Plan Augmentation (rule-based NLP) ───────────────────
// Domain-specific scenario patterns: if text matches pattern → add scenario
const SCENARIO_PATTERNS = [
  { pattern: /login|auth|sign.?in/i,         scenarios: [
    "Verify session timeout after inactivity period",
    "Verify concurrent login from multiple browsers is handled",
    "Verify account lockout after repeated failed attempts"
  ], risks: ["Session fixation or token replay vulnerability", "Brute-force attack on login endpoint"], types: ["Security"] },
  { pattern: /employee|pim|staff|personnel/i, scenarios: [
    "Verify employee record is searchable after creation",
    "Verify employee data export contains all fields accurately",
    "Verify cascading effects when modifying employee records"
  ], risks: ["PII data leakage in logs or exports"], types: ["Data Integrity"] },
  { pattern: /create|add|new|register/i,      scenarios: [
    "Verify system behaviour under rapid successive create operations",
    "Verify database constraints prevent orphaned records",
    "Verify audit trail captures the create event"
  ], risks: ["Race condition on duplicate creation attempts"], types: [] },
  { pattern: /upload|file|attach|import/i,    scenarios: [
    "Verify rejection of oversized file uploads",
    "Verify correct handling of zero-byte files",
    "Verify file type validation cannot be bypassed by renaming"
  ], risks: ["Malicious file execution via upload", "Server resource exhaustion from large uploads"], types: ["Security"] },
  { pattern: /delete|remove|deactivate/i,     scenarios: [
    "Verify soft-delete preserves data for audit",
    "Verify cascading delete does not remove related active records",
    "Verify confirmation dialog prevents accidental deletion"
  ], risks: ["Irreversible data loss without backup", "Orphaned references after deletion"], types: ["Data Integrity"] },
  { pattern: /update|edit|modify|change/i,    scenarios: [
    "Verify optimistic concurrency — two users editing same record",
    "Verify partial update does not corrupt existing data",
    "Verify change history/audit trail records the modification"
  ], risks: ["Lost update from concurrent modifications"], types: ["Concurrency"] },
  { pattern: /search|filter|find|query/i,     scenarios: [
    "Verify search returns results within acceptable time (< 3s)",
    "Verify SQL/NoSQL injection via search input is prevented",
    "Verify search with no results shows appropriate empty-state"
  ], risks: ["Injection through search parameters"], types: [] },
  { pattern: /report|dashboard|analytics/i,   scenarios: [
    "Verify report data accuracy matches source records",
    "Verify report handles large datasets without timeout"
  ], risks: ["Data aggregation errors in reports"], types: ["Performance"] },
  { pattern: /role|permission|access|admin/i,  scenarios: [
    "Verify direct URL access is blocked for unauthorized roles",
    "Verify API endpoints enforce the same RBAC as the UI",
    "Verify role downgrade takes immediate effect"
  ], risks: ["Horizontal privilege escalation via API", "Stale role cache allowing access after revocation"], types: ["Security"] },
  { pattern: /form|input|field|submit/i,      scenarios: [
    "Verify tab/keyboard navigation through all form fields",
    "Verify screen reader announces field labels and errors",
    "Verify form state is preserved on browser back navigation"
  ], risks: ["Accessibility non-compliance (WCAG)"], types: ["Accessibility"] },
  { pattern: /email|notification|alert|message/i, scenarios: [
    "Verify email is not sent for failed/rolled-back transactions",
    "Verify notification content does not expose sensitive data"
  ], risks: ["Sensitive data in notification payloads"], types: ["Integration"] },
  { pattern: /api|service|endpoint|webhook/i, scenarios: [
    "Verify API rate limiting prevents abuse",
    "Verify API returns correct HTTP status codes for each error type"
  ], risks: ["API abuse without rate limiting"], types: ["API Contract"] }
];

function augmentPlan(fields, allText, existingTypes, existingTechniques) {
  const summary = fields.summary || "";
  const criticalScenarios = [];
  const risks = [];
  const additionalTestTypes = [];

  for (const entry of SCENARIO_PATTERNS) {
    if (entry.pattern.test(allText)) {
      for (const s of entry.scenarios) {
        if (!criticalScenarios.includes(s)) criticalScenarios.push(s);
      }
      for (const r of entry.risks) {
        if (!risks.includes(r)) risks.push(r);
      }
      for (const t of entry.types) {
        if (!existingTypes.includes(t) && !additionalTestTypes.includes(t)) {
          additionalTestTypes.push(t);
        }
      }
    }
  }

  // Cap to keep plans manageable
  return {
    criticalScenarios: criticalScenarios.slice(0, 8),
    risks: risks.slice(0, 6),
    additionalTestTypes: additionalTestTypes.slice(0, 4)
  };
}

module.exports = { plan, extractText, tokenise, keywordMatches };
