'use strict';
const fs   = require("fs");
const path = require("path");

const RESULTS_FILE = path.resolve(__dirname, "..", "..", "test-results.json");

function getDashboard(req, res) {
  if (!fs.existsSync(RESULTS_FILE)) {
    return res.json({ total: 0, passed: 0, failed: 0, message: "No test results yet" });
  }
  try {
    const data = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf-8"));
    const tests = [];

    // Walk nested suites to collect all tests
    function walkSuites(suites) {
      for (const s of suites || []) {
        for (const t of s.tests || []) {
          tests.push(t);
        }
        if (s.suites) walkSuites(s.suites);
      }
    }
    walkSuites(data.suites);

    const passed = tests.filter(t => t.outcome === "expected").length;
    res.json({ total: tests.length, passed, failed: tests.length - passed });
  } catch (err) {
    res.status(500).json({ error: "Failed to parse test results" });
  }
}
module.exports = { getDashboard };
