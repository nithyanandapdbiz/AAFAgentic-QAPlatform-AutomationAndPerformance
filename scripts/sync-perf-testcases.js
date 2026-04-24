'use strict';
/**
 * sync-perf-testcases.js
 * ----------------------
 * Scans every generated k6 script under tests/perf/<profile>/<STORY>_<profile>.k6.js
 * and ensures each one has a matching Zephyr Scale test case. Writes the
 * basename → test-case-key map to tests/perf/perf-testcase-map.json so that
 * scripts/run-perf.js Stage 4 can post executions back to Zephyr.
 *
 * Idempotent: basenames already present in the map are skipped.
 *
 * Usage:
 *   node scripts/sync-perf-testcases.js            # sync all stories
 *   node scripts/sync-perf-testcases.js SCRUM-5    # only the given story
 *   node scripts/sync-perf-testcases.js --dry-run  # preview, no API calls
 */
const fs   = require('fs');
const path = require('path');
const { createTestCase } = require('../src/tools/zephyr.client');
const logger = require('../src/utils/logger');

const ROOT      = path.resolve(__dirname, '..');
const PERF_DIR  = path.join(ROOT, 'tests', 'perf');
const MAP_PATH  = path.join(PERF_DIR, 'perf-testcase-map.json');

const PROFILE_DESCRIPTIONS = {
  load:        'Sustained representative user load — validates steady-state p95/p99 latency and error-rate SLAs.',
  stress:      'Beyond-expected load — identifies the breaking point and graceful-degradation behaviour.',
  spike:       'Sudden traffic burst — validates resilience to rapid user increases and recovery afterwards.',
  soak:        'Extended duration at normal load — detects memory leaks, connection exhaustion, and slow degradation.',
  breakpoint:  'Gradually increasing load until SLA breach — measures maximum sustainable throughput.',
  scalability: 'Stepped load across increasing VU tiers — measures throughput scaling and saturation points.',
};

const C = { dim:'\x1b[2m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m', reset:'\x1b[0m', bold:'\x1b[1m' };

function parseArgs(argv) {
  const args = { storyFilter: null, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a && !a.startsWith('--')) args.storyFilter = a.toUpperCase();
  }
  return args;
}

function listPerfScripts() {
  if (!fs.existsSync(PERF_DIR)) return [];
  const out = [];
  for (const profile of fs.readdirSync(PERF_DIR)) {
    const profDir = path.join(PERF_DIR, profile);
    if (!fs.statSync(profDir).isDirectory()) continue;
    for (const file of fs.readdirSync(profDir)) {
      if (!file.endsWith('.k6.js')) continue;
      const basename = file.replace(/\.k6\.js$/, '');  // e.g. SCRUM-5_load
      const m = basename.match(/^([A-Z]+-\d+)_([a-z]+)$/);
      if (!m) continue;
      out.push({ storyKey: m[1], profile: m[2], basename, scriptPath: path.join(profDir, file) });
    }
  }
  return out;
}

function loadMap() {
  if (!fs.existsSync(MAP_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')) || {}; }
  catch (e) { logger.warn(`[sync-perf-tc] map parse failed: ${e.message}`); return {}; }
}

function saveMap(map) {
  fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + '\n', 'utf8');
}

function buildTestCase(entry) {
  const profile = entry.profile;
  const pretty  = profile.charAt(0).toUpperCase() + profile.slice(1);
  const objective = PROFILE_DESCRIPTIONS[profile] || `${pretty} performance test for ${entry.storyKey}.`;
  return {
    title:       `Performance — ${pretty} — ${entry.storyKey}`,
    description: objective,
    priority:    profile === 'soak' || profile === 'breakpoint' ? 'Low' : 'Normal',
    tags:        ['performance', `perf-${profile}`, entry.storyKey.toLowerCase()],
    steps:       [
      'Launch k6 with the generated script under tests/perf/' + profile + '/',
      'Execute the scenario against the configured BASE_URL',
      'Evaluate p95/p99/error-rate thresholds and compare against the rolling baseline'
    ],
    expected:    'All configured thresholds pass; no dropped iterations; p95/p99 within SLA and baseline tolerance.'
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const scripts = listPerfScripts();

  if (scripts.length === 0) {
    console.log(`${C.yellow}No perf scripts found under tests/perf/**/*.k6.js${C.reset}`);
    return;
  }

  const filtered = args.storyFilter
    ? scripts.filter(s => s.storyKey === args.storyFilter)
    : scripts;

  if (filtered.length === 0) {
    console.log(`${C.yellow}No perf scripts matched story filter "${args.storyFilter}"${C.reset}`);
    return;
  }

  const map      = loadMap();
  const missing  = filtered.filter(s => !map[s.basename]);

  console.log(`${C.bold}Perf → Zephyr mapping sync${C.reset}`);
  console.log(`  Discovered : ${filtered.length} script(s)`);
  console.log(`  Mapped     : ${filtered.length - missing.length}`);
  console.log(`  Missing    : ${missing.length}`);
  if (args.dryRun) console.log(`  ${C.yellow}(dry-run — no API calls will be made)${C.reset}`);

  if (missing.length === 0) {
    console.log(`${C.green}✓ Nothing to do — all perf scripts already mapped.${C.reset}`);
    return;
  }

  let created = 0, failed = 0;
  for (const entry of missing) {
    const tc = buildTestCase(entry);
    if (args.dryRun) {
      console.log(`  ${C.dim}would create:${C.reset} ${entry.basename}  →  "${tc.title}"`);
      continue;
    }
    try {
      const { key } = await createTestCase(tc);
      map[entry.basename] = key;
      saveMap(map);  // persist incrementally so partial runs aren't lost
      console.log(`  ${C.green}✓${C.reset} ${entry.basename}  →  ${key}`);
      created++;
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`  ${C.red}✗${C.reset} ${entry.basename}  —  ${detail}`);
      logger.error(`[sync-perf-tc] create failed for ${entry.basename}: ${detail}`);
      failed++;
    }
  }

  console.log(`\n${C.bold}Summary:${C.reset} created ${created}, failed ${failed}, already-mapped ${filtered.length - missing.length}`);
  console.log(`Map: ${path.relative(ROOT, MAP_PATH)}`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  logger.error(`[sync-perf-tc] fatal: ${err.stack || err.message}`);
  console.error(`${C.red}Fatal:${C.reset} ${err.message}`);
  process.exit(1);
});
