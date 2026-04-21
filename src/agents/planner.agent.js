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

// Keywords that indicate each test type applies
const TYPE_SIGNALS = {
  "Happy Path":     ["create", "add", "submit", "save", "login", "upload", "register", "complete", "update"],
  "Negative":       ["fail", "error", "invalid", "reject", "deny", "wrong", "missing", "not", "prevent"],
  "Edge Case":      ["empty", "null", "zero", "max", "min", "limit", "large", "special", "unicode", "blank"],
  "UI Validation":  ["field", "form", "input", "label", "button", "display", "screen", "page", "ui", "view"],
  "Security":       ["password", "auth", "permission", "access", "role", "admin", "token", "login", "secure"],
  "Boundary":       ["limit", "max", "min", "length", "count", "number", "size", "range", "character"],
  "Integration":    ["api", "sync", "service", "connect", "external", "third", "webhook", "email", "notification"],
  "performance":    [
    "load test", "stress test", "spike", "soak", "throughput",
    "latency", "response time", "concurrent users", "sla",
    "scalability", "performance", "benchmark"
  ],
  "security":       [
    "authentication", "authorisation", "authorization", "session",
    "token", "jwt", "password", "rbac", "permission", "injection", "xss",
    "csrf", "sql", "cookie", "sensitive data", "encryption", "ssl", "tls",
    "security header", "redirect", "owasp", "vulnerability"
  ],
  "security-scan":  [
    "owasp", "zap", "vulnerability", "penetration", "pentest",
    "injection", "xss", "csrf", "sql injection", "broken auth",
    "access control", "cryptographic", "misconfiguration",
    "insecure", "sensitive data", "idor", "ssrf", "brute force",
    "session fixation", "open redirect", "security scan",
    "security audit", "security testing"
  ]
};

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

async function plan(story) {
  const fields      = story.fields || {};
  const summary     = lower(fields.summary || "");
  const description = lower(extractText(fields.description));
  const ac          = lower(extractText(fields.customfield_10016) || extractText(fields.customfield_10014) || "");
  const allText     = `${summary} ${description} ${ac}`;

  // Determine applicable test types
  const testTypes = Object.entries(TYPE_SIGNALS)
    .filter(([, keywords]) => keywords.some(k => allText.includes(k)))
    .map(([type]) => type);
  if (testTypes.length === 0) testTypes.push("Happy Path", "Negative");

  // Determine applicable design techniques
  const designTechniques = Object.entries(TECHNIQUE_SIGNALS)
    .filter(([, keywords]) => keywords.some(k => allText.includes(k)))
    .map(([technique]) => technique);
  if (designTechniques.length === 0) designTechniques.push("Equivalence Partitioning", "Error Guessing");

  // Identify risks
  const risks = RISK_SIGNALS
    .filter(r => allText.includes(r.keyword))
    .map(r => r.risk);

  const criticalScenarios = [
    `Verify successful ${fields.summary || "operation"} with valid data`,
    `Verify system handles invalid or missing data gracefully`,
    `Verify UI feedback (success/error messages) is correct`
  ];

  // ── Contextual augmentation: deeper scenarios & risks (no external API) ──
  const augmented = augmentPlan(fields, allText, testTypes, designTechniques);
  for (const s of augmented.criticalScenarios) {
    if (!criticalScenarios.includes(s)) criticalScenarios.push(s);
  }
  for (const r of augmented.risks) {
    if (!risks.includes(r)) risks.push(r);
  }
  for (const t of augmented.additionalTestTypes) {
    if (!testTypes.includes(t)) testTypes.push(t);
  }

  if (augmented.criticalScenarios.length + augmented.risks.length + augmented.additionalTestTypes.length > 0) {
    logger.info("Planner: contextual augmentation applied — additional insights merged into plan");
  }

  return {
    scope: `Test all aspects of: ${fields.summary || "story"}`,
    testTypes,
    designTechniques,
    criticalScenarios,
    risks: risks.length > 0 ? risks : ["Unexpected system behaviour with boundary inputs"]
  };
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

module.exports = { plan, extractText };
