'use strict';
/**
 * Unit tests for the fuzzy text-matching enhancement in proactive-healer.js.
 *
 * Tests the two pure functions:
 *   - levenshteinDistance(str1, str2) → number
 *   - calculateLevenshteinSimilarity(str1, str2) → number  (0–1)
 *
 * Run with:  npm run test:unit
 *         or npx playwright test --config=playwright.unit.config.js
 */

const { describe, test, expect } = require('@playwright/test');

const {
  levenshteinDistance,
  calculateLevenshteinSimilarity,
} = require('../../scripts/proactive-healer');

// ─── levenshteinDistance ─────────────────────────────────────────────────────
describe('levenshteinDistance', () => {
  test('returns 0 for identical strings', () => {
    expect(levenshteinDistance('Employee', 'Employee')).toBe(0);
  });

  test('returns 3 for "Employee" → "Employee Id" (3 insertions)', () => {
    // " ", "I", "d" = 3 insertions
    expect(levenshteinDistance('Employee', 'Employee Id')).toBe(3);
  });

  test('handles single character substitution', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1);
  });

  test('handles single character insertion', () => {
    expect(levenshteinDistance('cat', 'cats')).toBe(1);
  });

  test('handles single character deletion', () => {
    expect(levenshteinDistance('cats', 'cat')).toBe(1);
  });

  test('returns length of str2 when str1 is empty', () => {
    expect(levenshteinDistance('', 'test')).toBe(4);
  });

  test('returns length of str1 when str2 is empty', () => {
    expect(levenshteinDistance('test', '')).toBe(4);
  });

  test('returns 0 for two empty strings', () => {
    expect(levenshteinDistance('', '')).toBe(0);
  });

  test('is case-sensitive by default', () => {
    expect(levenshteinDistance('Employee', 'employee')).toBeGreaterThan(0);
  });

  test('handles full replacement', () => {
    // "abc" vs "xyz" — 3 substitutions
    expect(levenshteinDistance('abc', 'xyz')).toBe(3);
  });
});

// ─── calculateLevenshteinSimilarity ──────────────────────────────────────────
describe('calculateLevenshteinSimilarity', () => {
  test('returns 1.0 for identical strings', () => {
    expect(calculateLevenshteinSimilarity('Employee', 'Employee')).toBe(1.0);
  });

  test('returns 1.0 for two empty strings', () => {
    expect(calculateLevenshteinSimilarity('', '')).toBe(1.0);
  });

  test('returns 0.0 for completely different strings of same length', () => {
    expect(calculateLevenshteinSimilarity('abc', 'xyz')).toBe(0.0);
  });

  test('"Employee" vs "Employee Id" similarity ≥ 0.70', () => {
    const sim = calculateLevenshteinSimilarity('Employee', 'Employee Id');
    expect(sim).toBeGreaterThanOrEqual(0.70);
    // longer = "Employee Id" (11), distance = 3 → (11-3)/11 ≈ 0.727
    expect(sim).toBeCloseTo(0.727, 2);
  });

  test('"Employee" vs "Customer" similarity < 0.70', () => {
    expect(calculateLevenshteinSimilarity('Employee', 'Customer')).toBeLessThan(0.70);
  });

  test('case-normalised "employee id" vs "Employee Id" similarity = 1.0', () => {
    expect(calculateLevenshteinSimilarity(
      'employee id'.toLowerCase(),
      'Employee Id'.toLowerCase()
    )).toBe(1.0);
  });

  test('"Name" vs "Full Name" — shorter string is minority of longer (≥ 0.40)', () => {
    // longer = "Full Name" (9), distance = 5 → (9-5)/9 ≈ 0.444
    // These strings differ too much to meet the 0.70 threshold — correct behaviour.
    expect(calculateLevenshteinSimilarity('Name', 'Full Name')).toBeGreaterThanOrEqual(0.40);
    expect(calculateLevenshteinSimilarity('Name', 'Full Name')).toBeLessThan(0.70);
  });

  test('"Email" vs "E-mail" similarity ≥ 0.70', () => {
    // longer = "E-mail" (6), distance ≤ 1 → (6-1)/6 ≈ 0.833
    expect(calculateLevenshteinSimilarity('Email', 'E-mail')).toBeGreaterThanOrEqual(0.70);
  });

  test('whitespace-normalised strings have similarity ≥ 0.90', () => {
    const s1 = 'Employee Id'.trim();
    const s2 = 'Employee  Id'.replace(/\s+/g, ' ').trim();
    expect(calculateLevenshteinSimilarity(s1, s2)).toBeGreaterThanOrEqual(0.90);
  });

  test('uses the longer string as denominator (asymmetric strings)', () => {
    // longer = "abcdef" (6), shorter = "abc" (3), distance = 3 → (6-3)/6 = 0.5
    expect(calculateLevenshteinSimilarity('abc', 'abcdef')).toBeCloseTo(0.5, 2);
  });
});

// ─── Real-world OrangeHRM label drift scenarios ───────────────────────────────
describe('Real-world label drift scenarios', () => {
  const THRESHOLD = 0.70;

  test('"Employee" → "Employee Id" should meet threshold', () => {
    expect(calculateLevenshteinSimilarity(
      'employee', 'employee id'
    )).toBeGreaterThanOrEqual(THRESHOLD);
  });

  test('"First Name" → "First Name *" (required marker) should meet threshold', () => {
    expect(calculateLevenshteinSimilarity(
      'first name', 'first name *'
    )).toBeGreaterThanOrEqual(THRESHOLD);
  });

  test('"Last Name" → "Surname" should NOT meet threshold (too different)', () => {
    expect(calculateLevenshteinSimilarity(
      'last name', 'surname'
    )).toBeLessThan(THRESHOLD);
  });

  test('"Save" → "Save Changes" below threshold (large suffix addition)', () => {
    // longer = "save changes" (12), distance = 8 → (12-8)/12 ≈ 0.333
    // Large additions correctly fall below the 0.70 threshold — manual review required.
    expect(calculateLevenshteinSimilarity(
      'save', 'save changes'
    )).toBeLessThan(THRESHOLD);
  });

  test('"Cancel" → "Discard" should NOT meet threshold (different words)', () => {
    expect(calculateLevenshteinSimilarity(
      'cancel', 'discard'
    )).toBeLessThan(THRESHOLD);
  });
});
