'use strict';
/** @module security.agent — Analyses a Jira story for security testing signals and produces OWASP checklist, ZAP config, and severity policy. */

const logger   = require('../utils/logger');
const AppError = require('../core/errorHandler');

// Keywords that trigger security test generation (case-insensitive)
const SEC_KEYWORDS = [
  'authentication', 'authorisation', 'authorization', 'session', 'token', 'jwt',
  'password', 'rbac', 'permission', 'injection', 'xss', 'csrf', 'sql', 'cookie',
  'sensitive data', 'encryption', 'ssl', 'tls', 'header', 'redirect', 'owasp'
];

// Full OWASP Top 10 (2021) definitions
const OWASP_TOP10 = [
  { id: 'A01:2021', name: 'Broken Access Control',                signals: ['rbac', 'permission', 'authoriz', 'csrf', 'cookie'],    scanType: 'both',   customChecks: ['csrf-token-absence', 'idor-employee-id'] },
  { id: 'A02:2021', name: 'Cryptographic Failures',              signals: ['sensitive data', 'encryption', 'password'],             scanType: 'both',   customChecks: ['sensitive-data-in-response', 'insecure-cookie-flags'] },
  { id: 'A03:2021', name: 'Injection',                           signals: ['injection', 'sql', 'xss'],                              scanType: 'both',   customChecks: ['sql-injection-signal', 'xss-reflection-signal'] },
  { id: 'A04:2021', name: 'Insecure Design',                     signals: [],                                                       scanType: 'zap',    customChecks: [] },
  { id: 'A05:2021', name: 'Security Misconfiguration',           signals: ['header', 'ssl', 'tls', 'csrf', 'cookie'],               scanType: 'both',   customChecks: ['missing-security-headers', 'insecure-cookie-flags'] },
  { id: 'A06:2021', name: 'Vulnerable and Outdated Components',  signals: [],                                                       scanType: 'zap',    customChecks: [] },
  { id: 'A07:2021', name: 'Identification and Authentication Failures', signals: ['auth', 'session', 'jwt', 'token', 'password'],  scanType: 'both',   customChecks: ['session-fixation', 'broken-auth-brute-force'] },
  { id: 'A08:2021', name: 'Software and Data Integrity Failures', signals: [],                                                      scanType: 'zap',    customChecks: [] },
  { id: 'A09:2021', name: 'Security Logging and Monitoring Failures', signals: [],                                                  scanType: 'zap',    customChecks: [] },
  { id: 'A10:2021', name: 'Server-Side Request Forgery (SSRF)',  signals: ['redirect'],                                             scanType: 'both',   customChecks: ['open-redirect'] },
];

/** Recursively extracts plain text from ADF or plain string */
function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) return node.content.map(extractText).join(' ');
  if (node.content) return extractText(node.content);
  return '';
}

/**
 * Analyse a Jira story for security signals and produce scan configuration.
 *
 * @param {object} story  - Jira story object
 * @param {object} [plan] - Optional plan from planner agent
 * @returns {object}      - { securityRequired, owaspChecklist, zapConfig, severityPolicy, customCheckNames }
 */
async function analyze(story, plan) {
  try {
    const fields      = story.fields || {};
    const summary     = (fields.summary     || story.summary     || '').toLowerCase();
    const description = extractText(fields.description || story.description || '').toLowerCase();
    const ac          = extractText(fields.customfield_10016 || fields.customfield_10014 || '').toLowerCase();
    const allText     = `${summary} ${description} ${ac}`;

    // ── 1. Signal detection ─────────────────────────────────────────────────
    const hasSecSignal = SEC_KEYWORDS.some(kw => allText.includes(kw));
    if (!hasSecSignal) {
      logger.info('[SecAgent] No security signals detected in story');
      return { securityRequired: false };
    }

    // ── 2. OWASP Category Mapper ────────────────────────────────────────────
    // A04 and A06 are always applicable
    const alwaysApplicable = new Set(['A04:2021', 'A06:2021']);

    const owaspChecklist = OWASP_TOP10.map(cat => {
      const applicable = alwaysApplicable.has(cat.id)
        || cat.signals.some(sig => allText.includes(sig));
      return {
        id:           cat.id,
        name:         cat.name,
        applicable,
        scanType:     cat.scanType,
        customChecks: applicable ? cat.customChecks : [],
      };
    });

    // ── 3. ZAP Scan Config Builder ──────────────────────────────────────────
    const hasInjectionOrAuth = /injection|sql|xss|auth|session|jwt|token/.test(allText);
    const hasSpa             = /spa|react|angular|vue/.test(allText);

    let scanType = process.env.ZAP_SCAN_TYPE || 'baseline';
    if (hasInjectionOrAuth && scanType === 'baseline') scanType = 'full';

    const zapConfig = {
      targetUrl:    process.env.BASE_URL || 'https://opensource-demo.orangehrmlive.com',
      scanType,
      contextName:  `${story.key || story.fields?.summary || 'story'}-context`,
      authScript:   /auth|session|jwt|token|password/.test(allText),
      ajaxSpider:   hasSpa,
      reportFormat: 'json',
    };

    // ── 4. Severity Policy ──────────────────────────────────────────────────
    const LEVELS = ['informational', 'low', 'medium', 'high', 'critical'];
    const failOn  = process.env.ZAP_FAIL_ON   || 'high';
    const failIdx = LEVELS.indexOf(failOn);
    const warnOn  = LEVELS[Math.max(0, failIdx - 1)];

    const severityPolicy = {
      failOn,
      warnOn,
      maxIssues: parseInt(process.env.ZAP_MAX_ISSUES || '0', 10),
    };

    // ── 5. Aggregate custom check names from applicable categories ──────────
    const customCheckNames = [...new Set(
      owaspChecklist
        .filter(c => c.applicable)
        .flatMap(c => c.customChecks)
    )];

    logger.info(`[SecAgent] Security analysis complete. scanType=${scanType}, customChecks=${customCheckNames.length}`);

    return {
      securityRequired: true,
      owaspChecklist,
      zapConfig,
      severityPolicy,
      customCheckNames,
    };
  } catch (err) {
    throw new AppError(`SecAgent analyze failed: ${err.message}`);
  }
}

module.exports = { analyze };
