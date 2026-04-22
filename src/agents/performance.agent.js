'use strict';
/** @module performance.agent — Analyses a Jira story for performance testing signals and produces load profiles, thresholds, and test type configs. */

const logger = require('../utils/logger');
const AppError = require('../core/errorHandler');

// Keywords that trigger performance test generation (case-insensitive)
const PERF_KEYWORDS = [
  'load', 'latency', 'throughput', 'concurrent', 'response time',
  'sla', 'stress', 'spike', 'volume', 'scalability', 'performance',
];

/** Recursively extracts plain text from Atlassian Document Format or plain string */
function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) return node.content.map(extractText).join(' ');
  if (node.content) return extractText(node.content);
  return '';
}

/**
 * Build the stages array for a given test type.
 * Warm-up stage (30s, 1 VU) is prepended for load/stress/soak/scalability.
 * @param {string} type
 * @param {object} loadProfile
 * @returns {Array<{duration:string, target:number}>}
 */
function buildStages(type, loadProfile) {
  const { vus, duration, rampUpTime, rampDownTime } = loadProfile;
  const soakDuration = process.env.PERF_SOAK_DURATION || '30m';
  const warmup = { duration: '30s', target: 1 };

  switch (type) {
    case 'load':
      return [
        warmup,
        { duration: '2m',          target: vus },
        { duration: '5m',          target: vus },
        { duration: '1m',          target: 0   },
      ];
    case 'stress':
      return [
        warmup,
        { duration: '3m',          target: vus     },
        { duration: '5m',          target: vus     },
        { duration: '2m',          target: vus * 2 },
        { duration: '3m',          target: vus * 2 },
        { duration: '2m',          target: 0       },
      ];
    case 'spike':
      // No warm-up for spike — must hit cold
      return [
        { duration: '10s',         target: vus * 3 },
        { duration: '1m',          target: vus * 3 },
        { duration: '10s',         target: 0       },
      ];
    case 'soak':
      return [
        warmup,
        { duration: '3m',          target: vus         },
        { duration: soakDuration,  target: vus         },
        { duration: rampDownTime,  target: 0           },
      ];
    case 'scalability': {
      const v10 = Math.max(1, Math.round(vus * 0.10));
      const v25 = Math.max(1, Math.round(vus * 0.25));
      const v50 = Math.max(1, Math.round(vus * 0.50));
      const v75 = Math.max(1, Math.round(vus * 0.75));
      return [
        warmup,
        { duration: '2m',          target: v10 },
        { duration: '2m',          target: v25 },
        { duration: '2m',          target: v50 },
        { duration: '2m',          target: v75 },
        { duration: '3m',          target: vus },
        { duration: '1m',          target: 0   },
      ];
    }
    case 'breakpoint':
      // Ramp from 1 → 2×VUs over 10 min; abortOnFail configured in script options
      return [
        { duration: '10m',         target: vus * 2 },
      ];
    default:
      return [
        warmup,
        { duration: rampUpTime,    target: vus },
        { duration: duration,      target: vus },
        { duration: rampDownTime,  target: 0   },
      ];
  }
}

/**
 * Analyse a Jira story for performance signals and produce load configuration.
 *
 * @param {object} story  - Jira story object (fields.summary, fields.description, etc.)
 * @param {object} [plan] - Optional plan object from planner agent (unused currently)
 * @returns {object}      - { perfRequired, loadProfile, thresholds, testTypes, slaSource }
 */
async function analyze(story, plan) {
  try {
    const fields      = story.fields || {};
    const summary     = (fields.summary     || story.summary     || '').toLowerCase();
    const description = extractText(fields.description || story.description || '').toLowerCase();
    const ac          = extractText(
      fields.customfield_10016 || fields.customfield_10014 || ''
    ).toLowerCase();
    const allText = `${summary} ${description} ${ac}`;

    // ── 1. Perf signal detection ────────────────────────────────────────────
    const hasPerfSignal = PERF_KEYWORDS.some(kw => allText.includes(kw));
    if (!hasPerfSignal) {
      logger.info('[PerfAgent] No performance signals detected in story');
      return { perfRequired: false };
    }

    // ── 2. Load profile builder ─────────────────────────────────────────────
    let vus = 25;
    if (/enterprise|thousands/i.test(allText)) vus += 25;

    // Allow env override for max VUs
    const vusMax = parseInt(process.env.PERF_VUS_MAX || '0', 10);
    if (vusMax > 0) vus = Math.min(vus, vusMax);

    const loadProfile = {
      vus,
      duration:     '5m',
      rampUpTime:   '2m',
      rampDownTime: '1m',
      thinkTime:    1,
    };

    // ── 3. Threshold calculator ─────────────────────────────────────────────
    // Try to parse SLA values from acceptance criteria
    let slaSource = 'default';
    let p95 = parseInt(process.env.PERF_THRESHOLDS_P95  || '2000', 10);
    let p99 = parseInt(process.env.PERF_THRESHOLDS_P99  || '5000', 10);
    const errorRate          = parseFloat(process.env.PERF_THRESHOLDS_ERROR_RATE || '0.01');
    const throughputDropPct  = parseFloat(process.env.PERF_BASELINE_TOLERANCE    || '0.20');

    // Parse "within N seconds" or "less than N ms" patterns from AC text
    const secMatch = ac.match(/within\s+(\d+(?:\.\d+)?)\s*seconds?/i);
    const msMatch  = ac.match(/less\s+than\s+(\d+(?:\.\d+)?)\s*ms/i);
    if (secMatch) {
      p95 = Math.round(parseFloat(secMatch[1]) * 1000);
      p99 = Math.round(p95 * 2.5);
      slaSource = 'parsed';
    } else if (msMatch) {
      p95 = Math.round(parseFloat(msMatch[1]));
      p99 = Math.round(p95 * 2.5);
      slaSource = 'parsed';
    }

    const thresholds = { p95, p99, errorRate, throughputDropPct };

    // ── 4. Per-test-type threshold map ──────────────────────────────────────
    // Each test type has different stress characteristics so thresholds are
    // scaled accordingly. Breakpoint intentionally breaches — no enforcement.
    const thresholdsByType = {
      load: {
        p95,
        p99,
        errorRate,
      },
      stress: {
        p95:       Math.round(p95 * 1.5),
        p99:       Math.round(p99 * 1.5),
        errorRate: parseFloat((errorRate * 2).toFixed(6)),
      },
      spike: {
        p95:       Math.round(p95 * 3),
        p99:       Math.round(p99 * 3),
        errorRate: 0.05,   // 5% errors acceptable during spike
      },
      soak: {
        p95:       Math.round(p95 * 1.2),
        p99:       Math.round(p99 * 1.2),
        errorRate,
      },
      scalability: {
        p95:       Math.round(p95 * 1.3),
        p99:       Math.round(p99 * 1.3),
        errorRate: parseFloat((errorRate * 1.5).toFixed(6)),
      },
      breakpoint: {
        p95:       Infinity,
        p99:       Infinity,
        errorRate: Infinity,
        note:      'breakpoint test — thresholds disabled by design',
      },
    };

    // ── 5. Test type mapper ─────────────────────────────────────────────────
    const testTypes = ['load', 'stress', 'spike', 'soak', 'scalability', 'breakpoint'];

    const scenarioConfigs = {};
    for (const type of testTypes) {
      scenarioConfigs[type] = {
        stages:     buildStages(type, loadProfile),
        thresholds: thresholdsByType[type],
      };
    }

    logger.info(`[PerfAgent] Performance analysis complete. VUs=${vus}, p95=${p95}ms, slaSource=${slaSource}`);

    return {
      perfRequired: true,
      loadProfile,
      thresholds,       // global defaults (backward-compat)
      thresholdsByType, // per-type SLA map
      testTypes,
      scenarioConfigs,
      slaSource,
    };
  } catch (err) {
    throw new AppError(`PerfAgent analyze failed: ${err.message}`);
  }
}

module.exports = { analyze, buildStages };
