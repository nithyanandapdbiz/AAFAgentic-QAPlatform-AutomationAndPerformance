'use strict';
/** @module performance.agent — Analyses a Jira story for performance testing signals and produces load profiles, thresholds, and test type configs. */

const logger = require('../utils/logger');
const AppError = require('../core/errorHandler');

// Keywords that trigger performance test generation (case-insensitive)
const PERF_KEYWORDS = [
  'load', 'latency', 'throughput', 'concurrent', 'response time',
  'sla', 'stress', 'spike', 'volume', 'scalability', 'performance'
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
 * @param {string} type
 * @param {object} loadProfile
 * @returns {Array<{duration:string, target:number}>}
 */
function buildStages(type, loadProfile) {
  const { vus, duration, rampUpTime, rampDownTime } = loadProfile;

  switch (type) {
    case 'load':
      return [
        { duration: rampUpTime,   target: vus },
        { duration: duration,     target: vus },
        { duration: rampDownTime, target: 0   },
      ];
    case 'stress':
      return [
        { duration: rampUpTime,   target: vus * 2 },
        { duration: duration,     target: vus * 2 },
        { duration: rampDownTime, target: 0        },
      ];
    case 'spike':
      return [
        { duration: '10s',        target: vus * 3 },
        { duration: '1m',         target: vus * 3 },
        { duration: '10s',        target: 0        },
      ];
    case 'soak': {
      const soakDuration = process.env.PERF_SOAK_DURATION || '30m';
      return [
        { duration: rampUpTime,   target: vus         },
        { duration: soakDuration, target: vus         },
        { duration: rampDownTime, target: 0           },
      ];
    }
    case 'scalability': {
      // Step ramp: 10% → 50% → 100% in equal intervals
      const step10  = Math.max(1, Math.round(vus * 0.1));
      const step50  = Math.max(1, Math.round(vus * 0.5));
      return [
        { duration: rampUpTime,   target: step10 },
        { duration: rampUpTime,   target: step50 },
        { duration: duration,     target: vus    },
        { duration: rampDownTime, target: 0      },
      ];
    }
    case 'breakpoint':
      // Ramp from 1 VU upward by 10 every 1m — k6 will stop on error threshold
      return [
        { duration: '10m', target: vus * 2 },
      ];
    default:
      return [
        { duration: rampUpTime,   target: vus },
        { duration: duration,     target: vus },
        { duration: rampDownTime, target: 0   },
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

    // ── 4. Test type mapper ─────────────────────────────────────────────────
    const testTypes = ['load', 'stress', 'spike', 'soak', 'scalability', 'breakpoint'];

    const scenarioConfigs = {};
    for (const type of testTypes) {
      scenarioConfigs[type] = {
        stages: buildStages(type, loadProfile),
      };
    }

    logger.info(`[PerfAgent] Performance analysis complete. VUs=${vus}, p95=${p95}ms, slaSource=${slaSource}`);

    return {
      perfRequired: true,
      loadProfile,
      thresholds,
      testTypes,
      scenarioConfigs,
      slaSource,
    };
  } catch (err) {
    throw new AppError(`PerfAgent analyze failed: ${err.message}`);
  }
}

module.exports = { analyze, buildStages };
