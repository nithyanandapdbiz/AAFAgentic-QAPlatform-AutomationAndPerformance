/**
 * Smoke-test for the enhanced agents (planner, QA, risk prioritizer).
 * Uses a mock Jira story — no external API calls needed.
 *
 * Run:  node scripts/test-agents.js
 */
require("dotenv").config();
const planner = require("../src/agents/planner.agent");
const qa      = require("../src/agents/qa.agent");
const riskP   = require("../src/agents/riskPrioritizer.agent");

const mockStory = {
  fields: {
    summary: "User Login to OrangeHRM Application",
    description: "As a user I want to login to the application with valid credentials so that I can access the dashboard. Input fields: username, password. Form validation required. Role-based access for Admin and ESS User.",
    issuetype: { name: "Story" },
    status: { name: "To Do" },
    priority: { name: "High" }
  }
};

(async () => {
  let fail = false;

  // ── Planner ──────────────────────────────────────────────────────
  console.log("=== PLANNER AGENT TEST ===");
  const plan = await planner.plan(mockStory);
  console.log("Scope:", plan.scope);
  console.log("Test Types:", plan.testTypes.join(", "));
  console.log("Design Techniques:", plan.designTechniques.join(", "));
  console.log("Critical Scenarios:", plan.criticalScenarios.length);
  plan.criticalScenarios.forEach((s, i) => console.log("  " + (i + 1) + ". " + s));
  console.log("Risks:", plan.risks.length);
  plan.risks.forEach(r => console.log("  - " + r));

  if (plan.criticalScenarios.length <= 3) {
    console.error("FAIL: Expected augmented critical scenarios (>3), got", plan.criticalScenarios.length);
    fail = true;
  } else {
    console.log("PASS: Planner augmentation produced", plan.criticalScenarios.length, "scenarios (>3 base)");
  }
  if (plan.risks.length <= 1) {
    console.error("FAIL: Expected augmented risks (>1), got", plan.risks.length);
    fail = true;
  } else {
    console.log("PASS: Planner found", plan.risks.length, "risks");
  }
  console.log();

  // ── QA Agent ─────────────────────────────────────────────────────
  console.log("=== QA AGENT TEST ===");
  const tcs = await qa.generate(mockStory, plan);
  console.log("Total TCs generated:", tcs.length);

  const dynamicTCs = tcs.filter(t => (t.tags || []).includes("dynamic-generated"));
  const staticTCs = tcs.length - dynamicTCs.length;
  console.log("Static template TCs:", staticTCs);
  console.log("Dynamic gap-analysis TCs:", dynamicTCs.length);
  dynamicTCs.forEach(t => console.log("  + " + t.title));

  if (dynamicTCs.length === 0) {
    console.error("FAIL: Dynamic generator produced 0 test cases");
    fail = true;
  } else {
    console.log("PASS: Dynamic generator produced", dynamicTCs.length, "additional TCs");
  }

  // Verify all TCs have required fields
  const invalid = tcs.filter(tc => !tc.title || !tc.gwt || !tc.steps || tc.steps.length < 3);
  if (invalid.length > 0) {
    console.error("FAIL:", invalid.length, "TC(s) missing required fields");
    fail = true;
  } else {
    console.log("PASS: All", tcs.length, "TCs have title, gwt, and >=3 steps");
  }
  console.log();

  // ── Risk Prioritizer ─────────────────────────────────────────────
  console.log("=== RISK PRIORITIZER TEST ===");
  const ranked = await riskP.prioritize(tcs, mockStory);
  console.log("Ranked order (highest risk first):");
  ranked.forEach((tc, i) => {
    const rs = tc.riskScore;
    console.log(
      "  " + (i + 1) + ". [Risk:" + rs.compositeRisk + "/10" +
      " | BI:" + rs.businessImpact +
      " FL:" + rs.failureLikelihood +
      " DS:" + rs.defectSeverity + "] " +
      tc.title.slice(0, 65)
    );
  });

  // Verify scores are present and ordered
  const scores = ranked.map(tc => tc.riskScore.compositeRisk);
  const isDescending = scores.every((s, i) => i === 0 || scores[i - 1] >= s);
  if (!isDescending) {
    console.error("FAIL: Test cases are not sorted in descending risk order");
    fail = true;
  } else {
    console.log("PASS: TCs sorted by composite risk (descending)");
  }

  const allHaveScores = ranked.every(tc =>
    tc.riskScore &&
    tc.riskScore.compositeRisk >= 1 &&
    tc.riskScore.compositeRisk <= 10
  );
  if (!allHaveScores) {
    console.error("FAIL: Some TCs missing valid risk scores");
    fail = true;
  } else {
    console.log("PASS: All", ranked.length, "TCs have valid risk scores (1-10)");
  }
  console.log();

  // ── Summary ──────────────────────────────────────────────────────
  if (fail) {
    console.error("=== SOME TESTS FAILED ===");
    process.exit(1);
  } else {
    console.log("=== ALL AGENT TESTS PASSED ===");
    console.log("  Planner: " + plan.criticalScenarios.length + " scenarios, " + plan.risks.length + " risks");
    console.log("  QA: " + tcs.length + " TCs (" + staticTCs + " static + " + dynamicTCs.length + " dynamic)");
    console.log("  Risk: " + ranked.length + " TCs scored & ranked, top risk=" + scores[0] + "/10");
  }
})();
