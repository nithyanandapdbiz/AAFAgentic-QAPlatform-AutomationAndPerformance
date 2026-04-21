'use strict';
/**
 * Unit tests for src/core/schemas.js
 *
 * Run with:
 *   npx playwright test tests/unit/schemas.test.js --project=chromium
 * Or (preferred) add a dedicated `unit` project in playwright.config.js that
 * matches `tests/unit/**\/*.test.js` without a browser.
 *
 * These tests are framework-agnostic (no page / browser) and will run under
 * Playwright test runner's Node worker. At least 3 valid + 3 invalid fixtures
 * per schema.
 */
const { test, expect } = require('@playwright/test');
const {
  validatePlannerOutput,          sanitizePlannerOutput,
  validateQATestCase,             sanitizeQATestCase,
  validateQAOutput,               sanitizeQAOutput,
  validateReviewerOutput,         sanitizeReviewerOutput,
  validateRiskPrioritizerOutput,  sanitizeRiskPrioritizerOutput,
  validateExecutorOutput,         sanitizeExecutorOutput
} = require('../../src/core/schemas');

// ───────────────────────── PlannerOutput ──────────────────────────────────
test.describe('PlannerOutput', () => {
  const validA = {
    scope: 'Test login',
    testTypes: ['Happy Path', 'Negative'],
    designTechniques: ['EP'],
    criticalScenarios: ['login ok'],
    risks: ['rate-limit'],
    confidence: 0.8
  };
  const validB = { ...validA, confidence: 0 };
  const validC = { ...validA, criticalScenarios: [], risks: [], confidence: 1 };

  for (const [i, obj] of [validA, validB, validC].entries()) {
    test(`valid #${i}`, () => {
      const r = validatePlannerOutput(obj);
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });
  }

  test('invalid: missing scope', () => {
    const r = validatePlannerOutput({ ...validA, scope: '' });
    expect(r.valid).toBe(false);
  });
  test('invalid: empty testTypes', () => {
    const r = validatePlannerOutput({ ...validA, testTypes: [] });
    expect(r.valid).toBe(false);
  });
  test('invalid: confidence > 1', () => {
    const r = validatePlannerOutput({ ...validA, confidence: 1.5 });
    expect(r.valid).toBe(false);
  });

  test('sanitize fills defaults', () => {
    const s = sanitizePlannerOutput(null);
    expect(s.scope).toBeTruthy();
    expect(s.testTypes.length).toBeGreaterThan(0);
    expect(s.confidence).toBe(0);
  });
});

// ───────────────────────── QATestCase / QAOutput ──────────────────────────
const validTC = () => ({
  title:       'TC: login success',
  description: 'User logs in with valid credentials',
  steps:       ['s1', 's2', 's3'],
  expected:    'dashboard loads',
  priority:    'High',
  tags:        ['smoke']
});

test.describe('QAOutput', () => {
  test('valid #1', () => {
    const r = validateQAOutput([validTC(), validTC(), validTC()]);
    expect(r.valid).toBe(true);
  });
  test('valid #2 empty array', () => {
    expect(validateQAOutput([]).valid).toBe(true);
  });
  test('valid #3 varied priorities', () => {
    const cases = ['High', 'Normal', 'Low'].map(p => ({ ...validTC(), priority: p }));
    expect(validateQAOutput(cases).valid).toBe(true);
  });

  test('invalid: not array', () => expect(validateQAOutput('nope').valid).toBe(false));
  test('invalid: case missing steps', () => {
    const bad = [{ ...validTC(), steps: ['s1'] }];
    expect(validateQAOutput(bad).valid).toBe(false);
  });
  test('invalid: bad priority', () => {
    const bad = [{ ...validTC(), priority: 'Urgent' }];
    expect(validateQAOutput(bad).valid).toBe(false);
  });

  test('sanitize pads steps and priority', () => {
    const out = sanitizeQAOutput([{ title: 't', description: 'd' }]);
    expect(out[0].steps.length).toBeGreaterThanOrEqual(3);
    expect(out[0].priority).toBe('Normal');
  });
});

// ───────────────────────── ReviewerOutput ─────────────────────────────────
test.describe('ReviewerOutput', () => {
  test('valid #1', () => expect(validateReviewerOutput([validTC()]).valid).toBe(true));
  test('valid #2 multiple', () => expect(validateReviewerOutput([validTC(), validTC()]).valid).toBe(true));
  test('valid #3 empty', () => expect(validateReviewerOutput([]).valid).toBe(true));

  test('invalid: non-array', () => expect(validateReviewerOutput({}).valid).toBe(false));
  test('invalid: missing title', () => {
    expect(validateReviewerOutput([{ ...validTC(), title: '' }]).valid).toBe(false);
  });
  test('invalid: missing expected', () => {
    expect(validateReviewerOutput([{ ...validTC(), expected: '' }]).valid).toBe(false);
  });

  test('sanitize sets defaults', () => {
    const s = sanitizeReviewerOutput([{}]);
    expect(s[0].title).toBeTruthy();
  });
});

// ───────────────────────── RiskPrioritizerOutput ──────────────────────────
const validPrioritized = () => ({
  ...validTC(),
  riskScore: {
    businessImpact: 7, failureLikelihood: 6, defectSeverity: 8,
    compositeRisk: 7, reasoning: 'High impact security flow'
  }
});

test.describe('RiskPrioritizerOutput', () => {
  test('valid #1', () => expect(validateRiskPrioritizerOutput([validPrioritized()]).valid).toBe(true));
  test('valid #2', () => expect(validateRiskPrioritizerOutput([validPrioritized(), validPrioritized()]).valid).toBe(true));
  test('valid #3 empty', () => expect(validateRiskPrioritizerOutput([]).valid).toBe(true));

  test('invalid: missing riskScore', () => {
    const bad = [{ ...validTC() }];
    expect(validateRiskPrioritizerOutput(bad).valid).toBe(false);
  });
  test('invalid: compositeRisk out of range', () => {
    const bad = [{ ...validPrioritized(), riskScore: { ...validPrioritized().riskScore, compositeRisk: 99 } }];
    expect(validateRiskPrioritizerOutput(bad).valid).toBe(false);
  });
  test('invalid: non-numeric businessImpact', () => {
    const bad = [{ ...validPrioritized(), riskScore: { ...validPrioritized().riskScore, businessImpact: 'high' } }];
    expect(validateRiskPrioritizerOutput(bad).valid).toBe(false);
  });

  test('sanitize fills riskScore defaults', () => {
    const s = sanitizeRiskPrioritizerOutput([{ title: 't', description: 'd' }]);
    expect(s[0].riskScore.compositeRisk).toBe(5);
  });
});

// ───────────────────────── ExecutorOutput ─────────────────────────────────
test.describe('ExecutorOutput', () => {
  test('valid #1', () => expect(validateExecutorOutput({ createdKeys: [] }).valid).toBe(true));
  test('valid #2', () => expect(validateExecutorOutput({ createdKeys: [{ id: 1, key: 'SCRUM-T1' }] }).valid).toBe(true));
  test('valid #3', () => expect(validateExecutorOutput({
    createdKeys: [{ id: 'a', key: 'K1' }, { id: 'b', key: 'K2' }, { id: 'c', key: 'K3' }]
  }).valid).toBe(true));

  test('invalid: not object', () => expect(validateExecutorOutput(null).valid).toBe(false));
  test('invalid: createdKeys not array', () => expect(validateExecutorOutput({ createdKeys: 'nope' }).valid).toBe(false));
  test('invalid: key empty', () => expect(validateExecutorOutput({ createdKeys: [{ id: 1, key: '' }] }).valid).toBe(false));

  test('sanitize filters invalid entries', () => {
    const s = sanitizeExecutorOutput({ createdKeys: [{ id: 1, key: 'OK' }, { id: 2, key: '' }, null] });
    expect(s.createdKeys.length).toBe(1);
    expect(s.createdKeys[0].key).toBe('OK');
  });
});

// ───────────────────────── Single-case smoke (validateQATestCase) ─────────
test.describe('QATestCase (single)', () => {
  test('valid', () => expect(validateQATestCase(validTC()).valid).toBe(true));
  test('sanitise null', () => {
    const s = sanitizeQATestCase(null);
    expect(s.title).toBeTruthy();
    expect(s.priority).toBe('Normal');
  });
});
