'use strict';
/**
 * Unit tests for the planner's word-boundary keyword scoring.
 *
 * Regression guard for false-positive substring matches such as:
 *   "load"   matching inside "upload" / "download" / "payload"
 *   "auth"   matching inside "oauth" / "reauthorise"
 *   "stress" matching inside "distress" / "address"
 *
 * Run with:  npx playwright test --config=playwright.unit.config.js
 */
const { test, expect } = require('@playwright/test');
const { plan, tokenise, keywordMatches } = require('../../src/agents/planner.agent');

function storyFromText(text) {
  return { key: 'SCRUM-TEST', fields: { summary: text, description: '', issuetype: { name: 'Story' } } };
}

function findCategoryScore(decisionMatches, category) {
  // matchedKeywords items: { keyword, weight, category }
  return decisionMatches
    .filter(m => m.category === category)
    .reduce((sum, m) => sum + m.weight, 0);
}

test.describe('planner tokenise()', () => {
  test('splits on whitespace and strips punctuation without merging tokens', () => {
    const tokens = tokenise('User can upload files; payload, download-done.');
    expect(tokens).toEqual(['user', 'can', 'upload', 'files', 'payload', 'download', 'done']);
  });

  test('lowercases input', () => {
    expect(tokenise('LOAD TEST')).toEqual(['load', 'test']);
  });

  test('returns empty array for empty/whitespace input', () => {
    expect(tokenise('')).toEqual([]);
    expect(tokenise('   ')).toEqual([]);
  });
});

test.describe('planner keywordMatches() — false-positive guards', () => {
  const mk = (text) => {
    const toks = tokenise(text);
    return { set: new Set(toks), padded: ` ${toks.join(' ')} ` };
  };

  test('"load" does NOT match inside "upload" / "download" / "payload"', () => {
    const { set, padded } = mk('User can upload and download the payload');
    expect(keywordMatches('load', set, padded)).toBe(false);
  });

  test('"auth" does NOT match inside "oauth" / "reauthorise"', () => {
    const { set, padded } = mk('The system uses oauth for delegated access and supports reauthorise flows');
    expect(keywordMatches('auth', set, padded)).toBe(false);
  });

  test('"stress" does NOT match inside "distress" / "address"', () => {
    const { set, padded } = mk('User can update their mailing address without distress');
    expect(keywordMatches('stress', set, padded)).toBe(false);
  });

  test('whole-word match still works', () => {
    const { set, padded } = mk('Run a load test during peak hours');
    expect(keywordMatches('load', set, padded)).toBe(true);
  });

  test('multi-word phrase match works and is word-bounded', () => {
    const a = mk('Engineer to run a load test on staging');
    expect(keywordMatches('load test', a.set, a.padded)).toBe(true);

    const b = mk('We will offload testing to QA');
    expect(keywordMatches('load test', b.set, b.padded)).toBe(false);
  });
});

test.describe('planner plan() — end-to-end false-positive guards', () => {
  test('story mentioning only "upload" does not trigger performance signals via "load"', async () => {
    const result = await plan(storyFromText('User can upload profile picture files'));
    // "upload" legitimately belongs to Happy Path. Performance must not fire off "load".
    expect(result.testTypes).not.toContain('performance');
  });

  test('story mentioning only "oauth" does not trigger security signals via "auth"', async () => {
    const result = await plan(storyFromText('System delegates login to an oauth provider'));
    // "authentication" / "authorisation" are separate full-word entries — not triggered by "oauth".
    // The bare "auth" token should no longer fire.
    // (Note: "login" legitimately triggers Happy Path — that's expected.)
    expect(result.testTypes).not.toContain('security');
  });

  test('story mentioning only "address" / "distress" does not trigger performance via "stress"', async () => {
    const result = await plan(storyFromText('User updates their mailing address to reduce distress'));
    expect(result.testTypes).not.toContain('performance');
  });
});
