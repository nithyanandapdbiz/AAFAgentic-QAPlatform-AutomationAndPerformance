'use strict';
const fs   = require("fs");
const path = require("path");

const RESULTS_FILE = path.resolve(__dirname, "..", "..", "test-results.json");

/**
 * Parses Playwright JSON reporter output.
 * Returns [{ title, passed, duration, error, retries }]
 */
function parseResults() {
  if (!fs.existsSync(RESULTS_FILE)) return [];

  const data = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf-8"));
  const out  = [];

  function walkSuites(suites) {
    for (const s of suites || []) {
      for (const t of s.tests || []) {
        const entry = {
          title:   t.title,
          passed:  t.outcome === "expected",
          duration: 0,
          error:   '',
          retries: 0
        };

        // Aggregate duration from all results (attempts)
        if (Array.isArray(t.results)) {
          entry.retries = Math.max(0, t.results.length - 1);
          for (const r of t.results) {
            entry.duration += (r.duration || 0);
          }
          // Extract error from final result
          const last = t.results[t.results.length - 1];
          if (last && last.error) {
            entry.error = (last.error.message || String(last.error)).slice(0, 500);
          }
        }

        out.push(entry);
      }
      if (s.suites) walkSuites(s.suites);
    }
  }

  walkSuites(data.suites);
  return out;
}
module.exports = { parseResults };
