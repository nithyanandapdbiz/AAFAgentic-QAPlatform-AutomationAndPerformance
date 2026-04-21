'use strict';
/**
 * schemas.js — lightweight, zero-dependency schema validators for agent outputs.
 *
 * Each `validate*` function returns `{ valid: boolean, errors: string[] }`.
 * Each `sanitize*` function returns a new object with defaults filled in for
 * missing or invalid fields. Sanitising NEVER throws and is safe to run on
 * any object (including null / undefined).
 *
 * @typedef  {object}  PlannerOutput
 * @property {string}              scope
 * @property {string[]}            testTypes
 * @property {string[]}            designTechniques
 * @property {string[]}            criticalScenarios
 * @property {string[]}            risks
 * @property {number}              confidence     - 0..1
 *
 * @typedef  {object}  QATestCase
 * @property {string}              title
 * @property {string}              description
 * @property {string}              [designTechnique]
 * @property {Array<string|object>} steps
 * @property {string}              expected
 * @property {('High'|'Normal'|'Low')} priority
 * @property {string[]}            tags
 *
 * @typedef {QATestCase[]}         QAOutput
 *
 * @typedef {QATestCase[]}         ReviewerOutput
 *
 * @typedef  {object}  RiskScore
 * @property {number}  businessImpact
 * @property {number}  failureLikelihood
 * @property {number}  defectSeverity
 * @property {number}  compositeRisk
 * @property {string}  reasoning
 *
 * @typedef  {QATestCase & { riskScore: RiskScore }} PrioritizedCase
 * @typedef  {PrioritizedCase[]}   RiskPrioritizerOutput
 *
 * @typedef  {object}  ExecutorOutput
 * @property {Array<{id: (string|number), key: string}>} createdKeys
 */

// ─── Tiny primitives ───────────────────────────────────────────────
function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function isStringArray(v)    { return Array.isArray(v) && v.every(x => typeof x === 'string'); }

// ─── PlannerOutput ─────────────────────────────────────────────────
function validatePlannerOutput(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['planner output is not an object'] };
  }
  if (!isNonEmptyString(obj.scope))               errors.push('scope must be a non-empty string');
  if (!isStringArray(obj.testTypes) || obj.testTypes.length === 0) errors.push('testTypes must be a non-empty string[]');
  if (!isStringArray(obj.designTechniques))       errors.push('designTechniques must be a string[]');
  if (!isStringArray(obj.criticalScenarios))      errors.push('criticalScenarios must be a string[]');
  if (!isStringArray(obj.risks))                  errors.push('risks must be a string[]');
  if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) {
    errors.push('confidence must be a number in [0, 1]');
  }
  return { valid: errors.length === 0, errors };
}

function sanitizePlannerOutput(obj) {
  const o = (obj && typeof obj === 'object') ? obj : {};
  return {
    scope:             isNonEmptyString(o.scope) ? o.scope : 'Test all aspects of the story',
    testTypes:         isStringArray(o.testTypes) && o.testTypes.length > 0 ? o.testTypes : ['Happy Path', 'Negative'],
    designTechniques:  isStringArray(o.designTechniques) && o.designTechniques.length > 0 ? o.designTechniques : ['Equivalence Partitioning', 'Error Guessing'],
    criticalScenarios: isStringArray(o.criticalScenarios) ? o.criticalScenarios : [],
    risks:             isStringArray(o.risks) ? o.risks : ['Unexpected system behaviour with boundary inputs'],
    confidence:        (typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1) ? o.confidence : 0
  };
}

// ─── QATestCase ────────────────────────────────────────────────────
const VALID_PRIORITIES = ['High', 'Normal', 'Low'];
function validateQATestCase(tc, idx = 0) {
  const errors = [];
  if (!tc || typeof tc !== 'object') return { valid: false, errors: [`case #${idx}: not an object`] };
  if (!isNonEmptyString(tc.title))       errors.push(`case #${idx}: title must be a non-empty string`);
  if (!isNonEmptyString(tc.description)) errors.push(`case #${idx}: description must be a non-empty string`);
  if (!Array.isArray(tc.steps) || tc.steps.length < 3) errors.push(`case #${idx}: steps must be an array with >= 3 entries`);
  if (!isNonEmptyString(tc.expected))    errors.push(`case #${idx}: expected must be a non-empty string`);
  if (!VALID_PRIORITIES.includes(tc.priority)) errors.push(`case #${idx}: priority must be High|Normal|Low`);
  if (!isStringArray(tc.tags))           errors.push(`case #${idx}: tags must be a string[]`);
  return { valid: errors.length === 0, errors };
}

function sanitizeQATestCase(tc) {
  const o = (tc && typeof tc === 'object') ? tc : {};
  const steps = Array.isArray(o.steps) ? [...o.steps] : [];
  while (steps.length < 3) steps.push(`Step ${steps.length + 1}: execute the test action`);
  return {
    ...o,
    title:       isNonEmptyString(o.title) ? o.title : 'Untitled test case',
    description: isNonEmptyString(o.description) ? o.description : 'Auto-sanitised description',
    steps,
    expected:    isNonEmptyString(o.expected) ? o.expected : 'The operation completes successfully without errors.',
    priority:    VALID_PRIORITIES.includes(o.priority) ? o.priority : 'Normal',
    tags:        isStringArray(o.tags) ? o.tags.map(t => String(t).toLowerCase()) : []
  };
}

// ─── QAOutput = QATestCase[] ──────────────────────────────────────
function validateQAOutput(arr) {
  if (!Array.isArray(arr)) return { valid: false, errors: ['QA output is not an array'] };
  const errors = [];
  arr.forEach((tc, i) => {
    const r = validateQATestCase(tc, i);
    if (!r.valid) errors.push(...r.errors);
  });
  return { valid: errors.length === 0, errors };
}

function sanitizeQAOutput(arr) {
  return (Array.isArray(arr) ? arr : []).map(sanitizeQATestCase);
}

// ─── ReviewerOutput = QATestCase[] (same shape post-enrichment) ───
const validateReviewerOutput = validateQAOutput;
const sanitizeReviewerOutput = sanitizeQAOutput;

// ─── RiskPrioritizerOutput = QATestCase[] with riskScore attached ─
function validateRiskPrioritizerOutput(arr) {
  if (!Array.isArray(arr)) return { valid: false, errors: ['Risk output is not an array'] };
  const errors = [];
  arr.forEach((tc, i) => {
    const base = validateQATestCase(tc, i);
    if (!base.valid) errors.push(...base.errors);
    if (!tc || typeof tc !== 'object' || !tc.riskScore || typeof tc.riskScore !== 'object') {
      errors.push(`case #${i}: riskScore must be an object`);
      return;
    }
    const rs = tc.riskScore;
    ['businessImpact', 'failureLikelihood', 'defectSeverity', 'compositeRisk'].forEach(k => {
      if (typeof rs[k] !== 'number' || rs[k] < 0 || rs[k] > 10) {
        errors.push(`case #${i}: riskScore.${k} must be number in [0, 10]`);
      }
    });
  });
  return { valid: errors.length === 0, errors };
}

function sanitizeRiskPrioritizerOutput(arr) {
  return (Array.isArray(arr) ? arr : []).map((tc, i) => {
    const base = sanitizeQATestCase(tc);
    const rs = (tc && tc.riskScore && typeof tc.riskScore === 'object') ? tc.riskScore : {};
    return {
      ...base,
      riskScore: {
        businessImpact:    typeof rs.businessImpact === 'number' ? rs.businessImpact : 5,
        failureLikelihood: typeof rs.failureLikelihood === 'number' ? rs.failureLikelihood : 5,
        defectSeverity:    typeof rs.defectSeverity === 'number' ? rs.defectSeverity : 5,
        compositeRisk:     typeof rs.compositeRisk === 'number' ? rs.compositeRisk : 5,
        reasoning:         isNonEmptyString(rs.reasoning) ? rs.reasoning : `Auto-assigned default (index ${i})`
      }
    };
  });
}

// ─── ExecutorOutput ───────────────────────────────────────────────
function validateExecutorOutput(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { valid: false, errors: ['executor output not an object'] };
  if (!Array.isArray(obj.createdKeys)) errors.push('createdKeys must be an array');
  else {
    obj.createdKeys.forEach((x, i) => {
      if (!x || typeof x !== 'object')  errors.push(`createdKeys[${i}]: not an object`);
      else if (!isNonEmptyString(x.key)) errors.push(`createdKeys[${i}]: key must be a non-empty string`);
    });
  }
  return { valid: errors.length === 0, errors };
}

function sanitizeExecutorOutput(obj) {
  const o = (obj && typeof obj === 'object') ? obj : {};
  return {
    createdKeys: Array.isArray(o.createdKeys)
      ? o.createdKeys.filter(x => x && typeof x === 'object' && isNonEmptyString(x.key))
      : []
  };
}

module.exports = {
  validatePlannerOutput,          sanitizePlannerOutput,
  validateQATestCase,             sanitizeQATestCase,
  validateQAOutput,               sanitizeQAOutput,
  validateReviewerOutput,         sanitizeReviewerOutput,
  validateRiskPrioritizerOutput,  sanitizeRiskPrioritizerOutput,
  validateExecutorOutput,         sanitizeExecutorOutput,
  VALID_PRIORITIES,
};
