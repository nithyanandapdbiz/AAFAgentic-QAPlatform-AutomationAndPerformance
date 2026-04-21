'use strict';
/**
 * pipeline/presets.js — Named sequences of step names for common workloads.
 *
 * Each preset is an ordered array of step names that must match keys in
 * `src/pipeline/steps.js :: STEPS`.
 *
 * Usage:
 *   const { runPipeline } = require('../src/pipeline/runner');
 *   const { PRESETS }     = require('../src/pipeline/presets');
 *   await runPipeline(PRESETS.full, ctx);
 */

const PRESETS = {
  // Functional-only path (most common fast iteration)
  functional: [
    'ensureDirs',
    'preFlight',
    'fetchStory',
    'generateSpecs',
    'proactiveHeal',
    'executeFunctional',
    'reactiveHeal',
    'createBugs',
    'generateReports',
    'syncGit',
  ],

  // Full end-to-end: functional + perf + security (perf/sec run in parallel)
  full: [
    'ensureDirs',
    'preFlight',
    'fetchStory',
    'generateSpecs',
    'proactiveHeal',
    'executeFunctional',
    'executePerfSec',
    'reactiveHeal',
    'createBugs',
    'generateReports',
    'syncGit',
  ],

  // CI-scoped path: assumes specs exist; skips story fetch & git
  scoped: [
    'ensureDirs',
    'preFlight',
    'generateSpecs',
    'proactiveHeal',
    'executeFunctional',
    'executePerfSec',
    'reactiveHeal',
    'generateReports',
  ],

  // Performance only
  perfOnly: [
    'ensureDirs',
    'preFlight',
    'fetchStory',
    'executePerformance',
    'generateReports',
  ],

  // Security only
  secOnly: [
    'ensureDirs',
    'preFlight',
    'fetchStory',
    'executeSecurity',
    'generateReports',
  ],
};

module.exports = { PRESETS };
