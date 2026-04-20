/**
 * Integration Validation Script
 * Tests live connectivity for Jira and Zephyr Essential Cloud API v2.8
 * Run: node scripts/validate-integration.js
 */
require("dotenv").config();
const axios = require("axios");

const jiraBase = (process.env.JIRA_URL || "").replace(/\/$/, "");
const jiraAuth = {
  username: process.env.JIRA_EMAIL,
  password: process.env.JIRA_API_TOKEN
};
const projectKey = process.env.PROJECT_KEY;
const issueKey   = process.env.ISSUE_KEY;

const zephyrBase = process.env.ZEPHYR_BASE_URL || "https://prod-api.zephyr4jiracloud.com/v2";
const zephyrToken = process.env.ZEPHYR_ACCESS_KEY;
const zephyrHeaders = {
  Authorization: zephyrToken,
  "Content-Type": "application/json",
  Accept: "application/json"
};

let passed = 0;
let failed = 0;

async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try {
    const result = await fn();
    console.log(`\x1b[32mPASS\x1b[0m${result ? " — " + result : ""}`);
    passed++;
  } catch (err) {
    const msg = err.response
      ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data).slice(0, 120)}`
      : err.message;
    console.log(`\x1b[31mFAIL\x1b[0m — ${msg}`);
    failed++;
  }
}

(async () => {
  console.log("\n\x1b[1m══════════════════════════════════════════\x1b[0m");
  console.log("\x1b[1m  Jira + Zephyr Integration Validator\x1b[0m");
  console.log("\x1b[1m══════════════════════════════════════════\x1b[0m\n");

  // ── ENV PRESENCE ─────────────────────────────
  console.log("\x1b[1m[1] Environment Variables\x1b[0m");
  await check("JIRA_URL set",        () => { if (!jiraBase)    throw new Error("missing"); return jiraBase; });
  await check("JIRA_EMAIL set",      () => { if (!process.env.JIRA_EMAIL) throw new Error("missing"); return process.env.JIRA_EMAIL; });
  await check("JIRA_API_TOKEN set",  () => { if (!process.env.JIRA_API_TOKEN) throw new Error("missing"); return "***"; });
  await check("PROJECT_KEY set",     () => { if (!projectKey)  throw new Error("missing"); return projectKey; });
  await check("ISSUE_KEY set",       () => { if (!issueKey)    throw new Error("missing"); return issueKey; });
  await check("ZEPHYR_BASE_URL set", () => { if (!zephyrBase)  throw new Error("missing"); return zephyrBase; });
  await check("ZEPHYR_ACCESS_KEY set",() =>{ if (!zephyrToken) throw new Error("missing"); return "***"; });

  // ── JIRA CONNECTIVITY ────────────────────────
  console.log("\n\x1b[1m[2] Jira Connectivity\x1b[0m");

  await check("GET /rest/api/3/myself (auth check)", async () => {
    const r = await axios.get(`${jiraBase}/rest/api/3/myself`, { auth: jiraAuth });
    return `logged in as ${r.data.displayName} (${r.data.emailAddress})`;
  });

  await check(`GET /rest/api/3/project/${projectKey}`, async () => {
    const r = await axios.get(`${jiraBase}/rest/api/3/project/${projectKey}`, { auth: jiraAuth });
    return `project "${r.data.name}" found`;
  });

  await check(`GET /rest/api/3/issue/${issueKey}`, async () => {
    const r = await axios.get(`${jiraBase}/rest/api/3/issue/${issueKey}`, { auth: jiraAuth });
    const summary = r.data.fields?.summary || "(no summary)";
    return `"${summary.slice(0, 60)}"`;
  });

  await check("GET /rest/api/3/issuetype — bug issuetype exists", async () => {
    const bugType = process.env.JIRA_BUG_ISSUETYPE || "Bug";
    const r = await axios.get(`${jiraBase}/rest/api/3/project/${projectKey}/statuses`, { auth: jiraAuth });
    const names = r.data.map(t => t.name);
    if (!names.includes(bugType)) throw new Error(`"${bugType}" not in [${names.join(", ")}] — set JIRA_BUG_ISSUETYPE in .env`);
    return `"${bugType}" issue type confirmed`;
  });

  // ── ZEPHYR CONNECTIVITY ──────────────────────
  console.log("\n\x1b[1m[3] Zephyr Essential Cloud API v2.8\x1b[0m");

  await check(`GET /testcases?projectKey=${projectKey} (auth + list)`, async () => {
    const r = await axios.get(`${zephyrBase}/testcases`, {
      headers: zephyrHeaders,
      params: { projectKey, maxResults: 1 }
    });
    const total = r.data.total ?? r.data.values?.length ?? "?";
    return `${total} total test case(s) in project`;
  });

  await check(`GET /testcycles?projectKey=${projectKey}`, async () => {
    const r = await axios.get(`${zephyrBase}/testcycles`, {
      headers: zephyrHeaders,
      params: { projectKey, maxResults: 1 }
    });
    const total = r.data.total ?? r.data.values?.length ?? "?";
    return `${total} total cycle(s)`;
  });

  await check(`GET /testexecutions?projectKey=${projectKey}`, async () => {
    const r = await axios.get(`${zephyrBase}/testexecutions`, {
      headers: zephyrHeaders,
      params: { projectKey, maxResults: 1 }
    });
    const total = r.data.total ?? r.data.values?.length ?? "?";
    return `${total} total execution(s)`;
  });

  await check("GET /priorities — metadata reachable", async () => {
    const r = await axios.get(`${zephyrBase}/priorities`, {
      headers: zephyrHeaders,
      params: { projectKey, maxResults: 5 }
    });
    const names = (r.data.values || r.data).map(p => p.name).join(", ");
    return names || "ok";
  });

  await check("GET /statuses — status metadata reachable", async () => {
    const r = await axios.get(`${zephyrBase}/statuses`, {
      headers: zephyrHeaders,
      params: { projectKey, maxResults: 5 }
    });
    const names = (r.data.values || r.data).map(s => s.name).join(", ");
    return names || "ok";
  });

  // ── SUMMARY ──────────────────────────────────
  console.log("\n\x1b[1m══════════════════════════════════════════\x1b[0m");
  const color = failed === 0 ? "\x1b[32m" : "\x1b[31m";
  console.log(`${color}\x1b[1m  Result: ${passed} passed, ${failed} failed\x1b[0m`);
  console.log("\x1b[1m══════════════════════════════════════════\x1b[0m\n");

  process.exit(failed > 0 ? 1 : 0);
})();
