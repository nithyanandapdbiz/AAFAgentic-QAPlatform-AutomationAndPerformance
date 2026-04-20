/**
 * Quick test for webhook & screenshot API endpoints.
 * Run: node scripts/test-endpoints.js
 */
'use strict';
const http = require("http");

const BASE = "http://localhost:3000";

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { "Content-Type": "application/json" }
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  let passed = 0, failed = 0;

  function check(label, ok, detail) {
    if (ok) { console.log(`  ✅ ${label}`); passed++; }
    else    { console.log(`  ❌ ${label} — ${detail}`); failed++; }
  }

  // ─── 1. Webhook Status ───────────────────────────────────
  console.log("\n🔹 GET /api/webhook/status");
  const ws = await request("GET", "/api/webhook/status");
  check("Status 200", ws.status === 200, `got ${ws.status}`);
  check("configured = true", ws.body.configured === true, JSON.stringify(ws.body));
  check("projectKey present", !!ws.body.projectKey, "missing");
  check("triggerStatuses array", Array.isArray(ws.body.triggerStatuses), "not array");
  check("cooldownMinutes > 0", ws.body.cooldownMinutes > 0, ws.body.cooldownMinutes);
  console.log("  Response:", JSON.stringify(ws.body, null, 2));

  // ─── 2. Webhook: Jira event — issue_created ──────────────
  console.log("\n🔹 POST /api/webhook/jira (issue_created)");
  const jiraPayload = {
    webhookEvent: "jira:issue_created",
    issue: {
      key: "SCRUM-99",
      fields: {
        project: { key: "SCRUM" },
        issuetype: { name: "Story" },
        status: { name: "To Do" },
        summary: "Test story from webhook endpoint test"
      }
    }
  };
  const wh1 = await request("POST", "/api/webhook/jira", jiraPayload);
  check("Status 202 (triggered)", wh1.status === 202, `got ${wh1.status}`);
  check("action = triggered", wh1.body.action === "triggered", wh1.body.action);
  check("issueKey = SCRUM-99", wh1.body.issueKey === "SCRUM-99", wh1.body.issueKey);
  console.log("  Response:", JSON.stringify(wh1.body, null, 2));

  // ─── 3. Webhook: Same issue again (cooldown) ─────────────
  console.log("\n🔹 POST /api/webhook/jira (same issue — expect throttle)");
  const wh2 = await request("POST", "/api/webhook/jira", jiraPayload);
  check("Status 200 (throttled)", wh2.status === 200, `got ${wh2.status}`);
  check("action = throttled", wh2.body.action === "throttled", wh2.body.action);
  console.log("  Response:", JSON.stringify(wh2.body, null, 2));

  // ─── 4. Webhook: Wrong project ────────────────────────────
  console.log("\n🔹 POST /api/webhook/jira (wrong project — expect ignored)");
  const wh3 = await request("POST", "/api/webhook/jira", {
    webhookEvent: "jira:issue_created",
    issue: { key: "OTHER-1", fields: { project: { key: "OTHER" }, issuetype: { name: "Story" }, status: { name: "To Do" }, summary: "x" } }
  });
  check("Status 200 (ignored)", wh3.status === 200, `got ${wh3.status}`);
  check("action = ignored", wh3.body.action === "ignored", wh3.body.action);

  // ─── 5. Webhook: comment /qa-run ──────────────────────────
  console.log("\n🔹 POST /api/webhook/jira (comment /qa-run)");
  const wh4 = await request("POST", "/api/webhook/jira", {
    webhookEvent: "comment_created",
    issue: { key: "SCRUM-100", fields: { project: { key: "SCRUM" }, issuetype: { name: "Story" }, status: { name: "In Progress" }, summary: "Another story" } },
    comment: { body: "Please /qa-run this story", author: { displayName: "Tester" } }
  });
  check("Status 202 (triggered via /qa-run)", wh4.status === 202, `got ${wh4.status}`);
  check("action = triggered", wh4.body.action === "triggered", wh4.body.action);
  console.log("  Response:", JSON.stringify(wh4.body, null, 2));

  // ─── 6. Manual trigger ────────────────────────────────────
  console.log("\n🔹 POST /api/webhook/manual");
  const mt = await request("POST", "/api/webhook/manual", { issueKey: "SCRUM-200" });
  check("Status 202", mt.status === 202, `got ${mt.status}`);
  check("action = triggered", mt.body.action === "triggered", mt.body.action);
  console.log("  Response:", JSON.stringify(mt.body, null, 2));

  // ─── 7. Manual trigger — missing issueKey ─────────────────
  console.log("\n🔹 POST /api/webhook/manual (no issueKey — expect 400)");
  const mt2 = await request("POST", "/api/webhook/manual", {});
  check("Status 400", mt2.status === 400, `got ${mt2.status}`);

  // ─── 8. Webhook: invalid signature ────────────────────────
  console.log("\n🔹 POST /api/webhook/jira (no body — expect 400)");
  const wh5 = await request("POST", "/api/webhook/jira", {});
  check("Status 400 (missing webhookEvent)", wh5.status === 400, `got ${wh5.status}`);

  // ─── 9. Screenshot Summary ────────────────────────────────
  console.log("\n🔹 GET /api/screenshots/summary");
  const ss = await request("GET", "/api/screenshots/summary");
  check("Status 200", ss.status === 200, `got ${ss.status}`);
  check("totalTests is number", typeof ss.body.totalTests === "number", typeof ss.body.totalTests);
  check("totalScreenshots is number", typeof ss.body.totalScreenshots === "number", typeof ss.body.totalScreenshots);
  console.log("  Response:", JSON.stringify(ss.body, null, 2));

  // ─── 10. Screenshot List ──────────────────────────────────
  console.log("\n🔹 GET /api/screenshots");
  const sl = await request("GET", "/api/screenshots");
  check("Status 200", sl.status === 200, `got ${sl.status}`);
  check("has tests array", Array.isArray(sl.body.tests), "not array");
  const totalShots = sl.body.total || 0;
  console.log(`  Total screenshots: ${totalShots}, Tests: ${(sl.body.tests || []).length}`);

  // If there are screenshots, test serving one
  if (sl.body.tests && sl.body.tests.length > 0) {
    const firstTest = sl.body.tests[0];
    console.log(`\n🔹 GET /api/screenshots/${firstTest.testName}`);
    const tl = await request("GET", `/api/screenshots/${encodeURIComponent(firstTest.testName)}`);
    check("Status 200", tl.status === 200, `got ${tl.status}`);
    check("has screenshots", tl.body.count > 0, `count=${tl.body.count}`);

    if (firstTest.screenshots && firstTest.screenshots.length > 0) {
      const imgUrl = firstTest.screenshots[0].url;
      console.log(`\n🔹 GET ${imgUrl} (serve image)`);
      const img = await request("GET", imgUrl);
      check("Status 200", img.status === 200, `got ${img.status}`);
      check("Body is non-empty", typeof img.body === "string" ? img.body.length > 0 : true, "empty");
    }
  }

  // ─── 11. Screenshot: path traversal protection ────────────
  console.log("\n🔹 GET /api/screenshots/../etc/passwd (path traversal — expect 400)");
  const pt = await request("GET", "/api/screenshots/..%2Fetc/passwd");
  check("Status 400 or 404", pt.status === 400 || pt.status === 404, `got ${pt.status}`);

  // ─── Summary ──────────────────────────────────────────────
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  RESULTS: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log(`${"═".repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error("Test error:", err); process.exit(1); });
