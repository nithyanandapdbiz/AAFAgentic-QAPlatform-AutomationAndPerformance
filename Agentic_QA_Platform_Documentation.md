# Agentic QA Platform — Complete Documentation

> **Version:** 2.0.0 &nbsp;|&nbsp; **Updated:** April 21, 2026 &nbsp;|&nbsp; **Runtime:** Node.js 20+ &nbsp;|&nbsp; **Module System:** CommonJS

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Project Structure](#3-project-structure)
4. [Configuration & Environment](#4-configuration--environment)
5. [AI Agent Pipeline](#5-ai-agent-pipeline)
6. [Performance Testing Pillar](#6-performance-testing-pillar)
7. [Security Testing Pillar](#7-security-testing-pillar)
8. [Test Framework](#8-test-framework)
9. [Page Object Model (POM)](#9-page-object-model-pom)
10. [Fixture System & ScreenshotHelper](#10-fixture-system--screenshothelper)
11. [Self-Healing Agent](#11-self-healing-agent)
12. [Pipeline Scripts Reference](#12-pipeline-scripts-reference)
13. [Report Generation](#13-report-generation)
14. [Service Layer](#14-service-layer)
15. [REST API & Dashboard](#15-rest-api--dashboard)
16. [Git Agent](#16-git-agent)
17. [CI/CD — GitHub Actions](#17-cicd--github-actions)
18. [npm Scripts Reference](#18-npm-scripts-reference)
19. [Quick Start Guide](#19-quick-start-guide)
20. [Troubleshooting](#20-troubleshooting)

---

## 1. Executive Summary

The **Agentic QA Platform** is a fully autonomous, end-to-end Quality Assurance system that transforms a Jira user story into:

- AI-generated test cases (6 design techniques) created in **Zephyr Scale**
- **Playwright** spec files with Page Object Model, auto-executed in parallel
- **k6** performance tests (load, stress, spike, soak, scalability, breakpoint)
- **OWASP ZAP** + custom security checks mapped to OWASP Top 10 (2021)
- Self-healed specs, Jira bug tickets, and three HTML reports

All with **zero human input** after the initial `.env` configuration.

### Capabilities Summary

| Pillar | Technology | What It Does |
|---|---|---|
| **Functional** | Playwright + POM + Allure | Generates, executes, heals, and syncs 17+ spec files per story |
| **Performance** | k6 (Grafana) | Generates and runs load/stress/spike/soak/scalability/breakpoint tests |
| **Security** | OWASP ZAP + custom checks | Runs active/passive scans + OWASP Top 10 custom verifications |
| **AI Agents** | Rule-based (no LLM required) | 5 agents: Planner → QA → Reviewer → RiskPrioritizer → Executor |
| **Test Management** | Zephyr Scale Cloud v2.8 | Creates/reads TCs, cycles, executions, automates `automationStatus` |
| **Bug Tracking** | Jira REST API v3 | Auto-creates linked bug tickets with ADF description + screenshots |
| **Reporting** | Custom HTML + Allure + Chart.js | Functional, Performance, Security, Allure — 4 independent reports |
| **CI/CD** | GitHub Actions | Full 3-pillar pipeline on push to `main`; all artifacts uploaded |
| **Delivery** | Git Agent | Auto-commits and pushes all generated artifacts |

### Test Design Techniques Applied

| Abbrev | Technique | Applied To |
|---|---|---|
| **BVA** | Boundary Value Analysis | Numeric fields, string lengths, count limits |
| **EP** | Equivalence Partitioning | Valid / invalid / empty input classes |
| **DT** | Decision Table | Multi-condition combinations, RBAC roles |
| **ST** | State Transition | Multi-step flows, status changes, navigation |
| **EG** | Error Guessing | Special chars, duplicates, unicode, overflow |
| **UC** | Use Case / Scenario | End-to-end user journeys, acceptance criteria |

---

## 2. Architecture Overview

### Full System Diagram

```
 AGENTIC QA PLATFORM  — 3-Pillar Architecture
 ─────────────────────────────────────────────────────────────────────────────
 EXTERNAL SYSTEMS
   Jira Cloud REST API v3       Zephyr Scale Cloud v2.8     OWASP ZAP Daemon
   (Stories, Bugs, Webhooks)    (TCs, Cycles, Executions)   (localhost:8080)
         │                               │                         │
 API CLIENT LAYER  (src/tools/)
   jira.client.js  │  jiraBug.client.js  │  zephyr.client.js
   zephyrCycle.client.js  │  zephyrExecution.client.js
   playwright.generator.js  │  perfScript.generator.js  │  secScript.generator.js
         │
 AI AGENT LAYER  (src/agents/)
   Planner → QA → Reviewer → RiskPrioritizer → Executor
   Performance Agent                Security Agent
         │
 ORCHESTRATION LAYER  (src/orchestrator/)
   agentOrchestrator.js  │  finalFlow.js
         │
   ┌─────┴─────────────────────────┐
   ▼                               ▼
 FUNCTIONAL PILLAR       PERFORMANCE PILLAR       SECURITY PILLAR
 Playwright + POM        k6 Scripts               ZAP + Custom Checks
 Fixtures + Healer       load/stress/spike        OWASP Top 10
 Bug Creator             soak/scalability         Findings Parser
   │                               │                         │
   └───────────────────────────────┼─────────────────────────┘
                                   ▼
 REPORTING LAYER  (scripts/)
   generate-report.js  │  generate-perf-report.js  │  generate-sec-report.js
   generate-allure-report.js
                                   │
 GIT AGENT  (scripts/git-sync.js)
   Auto-commit + push all artifacts
```

### Data Flow

```
ISSUE_KEY (e.g. SCRUM-5)
  │
  ├─▶ Jira: fetch story fields (summary, description, AC, assignee)
  ├─▶ Planner Agent: keyword NLP → test types, design techniques, risks
  ├─▶ QA Agent: 11 static + 6 dynamic templates → test cases with GWT steps
  ├─▶ Reviewer Agent: deduplicate (Levenshtein ≥ 0.85), normalise, enrich
  ├─▶ Risk Prioritizer: score on 3 dimensions → sort by composite risk score
  ├─▶ Executor Agent: POST /testcases in Zephyr + write tests/specs/*.spec.js
  ├─▶ Performance Agent: detect signals → k6 load profile + scripts
  ├─▶ Security Agent: detect signals → OWASP checklist + ZAP config
  ├─▶ Playwright execution → test-results.json, allure-results/
  ├─▶ Self-Healer: classify failures → patch specs → re-run
  ├─▶ Zephyr Sync: create cycle → executions → status → markAsAutomated
  ├─▶ k6 execution: run scripts → evaluate SLAs → update baselines
  ├─▶ ZAP execution: spider → active scan → custom checks → evaluate
  ├─▶ Jira Bugs: POST /issues for each remaining failure + attach screenshot
  ├─▶ Reports: functional + performance + security + allure HTML
  └─▶ Git Agent: commit "chore(qa-pipeline): …" → push
```

---

## 3. Project Structure

```
AAFAgentic-QAPlatform-AutomationAndPerformance/
│
├── .env                            ← Runtime config (credentials, flags)
├── .env.example                    ← Template for .env
├── .github/workflows/qa.yml        ← GitHub Actions pipeline
├── package.json                    ← npm scripts + dependencies
├── playwright.config.js            ← Playwright global config
│
├── src/                            ← Core platform source
│   ├── main.js                     ← Express API server entry point (port 3000)
│   │
│   ├── agents/
│   │   ├── planner.agent.js        ← Story analysis → test plan (NLP, no LLM)
│   │   ├── qa.agent.js             ← Test plan → test cases with GWT steps
│   │   ├── reviewer.agent.js       ← Dedup (Levenshtein) + normalise + enrich
│   │   ├── riskPrioritizer.agent.js← Multi-factor risk scoring + sort
│   │   ├── executor.agent.js       ← Create in Zephyr + generate spec stubs
│   │   ├── performance.agent.js    ← Perf signal analysis + k6 stage builder
│   │   └── security.agent.js       ← Security signal analysis + OWASP mapper
│   │
│   ├── orchestrator/
│   │   ├── agentOrchestrator.js    ← Chains all 5 core agents sequentially
│   │   └── finalFlow.js            ← Post-execution: cycle, bugs, coverage
│   │
│   ├── tools/
│   │   ├── jira.client.js          ← GET /rest/api/3/issue/:key
│   │   ├── jiraBug.client.js       ← POST /rest/api/3/issue (bug creation)
│   │   ├── zephyr.client.js        ← POST/GET /v2/testcases
│   │   ├── zephyrCycle.client.js   ← POST /v2/testcycles
│   │   ├── zephyrExecution.client.js ← POST/PUT /v2/testexecutions
│   │   ├── playwright.generator.js ← Write generated spec stubs
│   │   ├── perfScript.generator.js ← Write k6 script files
│   │   └── secScript.generator.js  ← Write ZAP scan config JSON
│   │
│   ├── services/
│   │   ├── bug.service.js          ← createBugsForFailures()
│   │   ├── coverage.service.js     ← calculateCoverage()
│   │   ├── cycle.service.js        ← setupCycle() / completeCycle()
│   │   ├── execution.service.js    ← runPlaywright()
│   │   ├── executionMapping.service.js ← mapResults() → Zephyr sync
│   │   ├── flaky.service.js        ← detectFlaky() — rolling-window in-memory
│   │   ├── perf.execution.service.js   ← k6 runner + threshold evaluator + baselines
│   │   └── sec.execution.service.js    ← ZAP lifecycle + custom checks + findings
│   │
│   ├── api/
│   │   ├── routes.js               ← All route registrations
│   │   ├── dashboard.controller.js ← GET /api/dashboard
│   │   ├── webhook.controller.js   ← POST /api/webhook/jira|manual
│   │   ├── screenshot.controller.js← GET /api/screenshots/*
│   │   ├── perf.controller.js      ← GET /api/perf/summary
│   │   └── security.controller.js  ← GET /api/security/summary
│   │
│   ├── core/
│   │   ├── config.js               ← Typed config (jira, zephyr, port)
│   │   └── errorHandler.js         ← AppError class
│   │
│   └── utils/
│       ├── logger.js               ← Winston logger
│       ├── resultParser.js         ← Parse test-results.json
│       ├── retry.js                ← Async retry(fn, retries, delay)
│       ├── openai.js               ← Optional OpenAI wrapper (agents unused)
│       └── zephyrJwt.js            ← JWT helper for Zephyr auth
│
├── scripts/                        ← CLI pipeline scripts
│   ├── ensure-dirs.js              ← Create all output directories
│   ├── run-story.js                ← Fetch story → Zephyr TCs
│   ├── generate-playwright.js      ← Zephyr TCs → tests/specs/*.spec.js
│   ├── generate-perf-scripts.js    ← Story → k6 scripts
│   ├── generate-sec-scripts.js     ← Story → ZAP scan config
│   ├── run-and-sync.js             ← Execute Playwright + sync Zephyr
│   ├── healer.js                   ← Self-Healing Agent (6 strategies)
│   ├── create-jira-bugs.js         ← Auto Jira bug creator
│   ├── run-perf.js                 ← 6-stage performance pipeline
│   ├── run-security.js             ← 7-stage security pipeline
│   ├── generate-report.js          ← Functional HTML report
│   ├── generate-allure-report.js   ← Allure HTML report
│   ├── generate-perf-report.js     ← Performance HTML report (Chart.js)
│   ├── generate-sec-report.js      ← Security HTML report (Chart.js)
│   ├── git-sync.js                 ← Git Agent (commit + push)
│   ├── run-full-pipeline.js        ← 8-stage functional pipeline
│   ├── run-qa-complete.js          ← 14-stage all-3-pillars pipeline
│   ├── run-e2e.js                  ← 15-stage complete E2E pipeline
│   ├── run-story-tests.js          ← Run tests for a specific story
│   ├── run-tagged-tests.js         ← Run tests filtered by tag
│   ├── qa-run.js                   ← Lightweight QA runner
│   ├── diag-zephyr.js              ← Zephyr API diagnostics
│   ├── validate-integration.js     ← Integration health check
│   └── test-agents.js / test-endpoints.js ← Dev diagnostics
│
├── tests/
│   ├── specs/                      ← Generated Playwright specs (one per Zephyr TC)
│   │   └── SCRUM-T{n}_*.spec.js
│   ├── pages/                      ← Page Object Model classes
│   │   ├── LoginPage.js / LoginPage.yml
│   │   ├── AddEmployeePage.js / AddEmployeePage.yml
│   │   └── EmployeeListPage.js / EmployeeListPage.yml
│   ├── fixtures/
│   │   ├── base.fixture.js         ← Composed fixture (POM + ScreenshotHelper + hooks)
│   │   └── pom.fixture.js          ← POM-only fixture
│   ├── helpers/
│   │   ├── locatorLoader.js        ← Load selectors from .yml
│   │   └── screenshot.helper.js    ← ScreenshotHelper (step-level captures)
│   ├── data/
│   │   └── testData.js             ← CREDENTIALS, TEST_EMPLOYEE, ROUTES
│   ├── perf/                       ← k6 scripts (auto-generated)
│   │   ├── load/ stress/ spike/ soak/ scalability/ breakpoint/
│   │   ├── baselines/baseline.json
│   │   └── perf-testcase-map.json
│   ├── security/                   ← ZAP scan config (auto-generated)
│   │   ├── SCRUM-5-scan-config.json
│   │   └── sec-testcase-map.json
│   ├── healed/                     ← Healed spec copies (originals preserved)
│   ├── global-setup.js             ← Health-check AUT, cache auth, clean dirs
│   └── global-teardown.js
│
├── custom-report/
│   ├── index.html                  ← Functional report
│   ├── perf/index.html             ← Performance report
│   └── security/index.html         ← Security report
│
├── allure-report/                  ← Allure interactive report
├── allure-results/                 ← Raw Allure JSON + attachments
├── playwright-report/              ← Playwright built-in HTML report
├── test-results/                   ← Screenshots, videos, perf/security JSONs
├── test-results.json               ← Playwright JSON reporter output
├── test-results-healed.json        ← Post-healing test results
├── .story-testcases.json           ← Story → TC key mapping cache
└── logs/                           ← Winston log files
```

---

## 4. Configuration & Environment

All configuration is read from `.env`. Copy `.env.example` to `.env` and fill in the values.

### Complete `.env` Reference

```dotenv
# ── Jira ──────────────────────────────────────────────────────────────────────
JIRA_URL=https://your-org.atlassian.net/       # Must be a valid absolute URL
JIRA_EMAIL=your@email.com
JIRA_API_TOKEN=<Jira API token>
PROJECT_KEY=SCRUM                               # Jira project key
ISSUE_KEY=SCRUM-5                               # Story to test
JIRA_BUG_ISSUETYPE=Bug                          # Issue type for auto-created bugs

# ── Zephyr Scale Cloud API v2.8 ────────────────────────────────────────────────
ZEPHYR_BASE_URL=https://prod-api.zephyr4jiracloud.com/v2
ZEPHYR_ACCESS_KEY=<JWT token from Zephyr → API Keys>

# ── API Server ─────────────────────────────────────────────────────────────────
PORT=3000
API_SECRET=<random secret for protected endpoints>  # optional

# ── Playwright ─────────────────────────────────────────────────────────────────
PW_HEADLESS=false              # true = CI headless mode
PW_WORKERS=3                   # parallel workers (number or "50%")
PW_GREP=<regex>                # filter tests by title (optional)

# ── Jira Webhooks ──────────────────────────────────────────────────────────────
WEBHOOK_SECRET=<HMAC-SHA256 secret>                # optional
WEBHOOK_TRIGGER_STATUSES=In Progress,Selected for Development,To Do

# ── Performance (k6) ──────────────────────────────────────────────────────────
PERF_K6_BINARY=k6              # path to k6 binary if not on PATH
PERF_THRESHOLDS_P95=2000       # p95 SLA in ms
PERF_THRESHOLDS_P99=5000       # p99 SLA in ms
PERF_THRESHOLDS_ERROR_RATE=0.01 # max error rate (1%)
PERF_VUS_MAX=50                # max virtual users
PERF_SOAK_DURATION=30m         # soak test duration
PERF_SKIP_SOAK=false           # true = skip soak (recommended in CI)
PERF_BASELINE_TOLERANCE=0.20   # 20% regression tolerance
PERF_STORY_DESCRIPTION=        # optional text injected into performance agent

# ── Security (OWASP ZAP) ──────────────────────────────────────────────────────
ZAP_HOST=localhost
ZAP_PORT=8080
ZAP_API_URL=http://localhost:8080
ZAP_DOCKER=false               # true = pull + start ZAP in Docker automatically
ZAP_API_KEY=changeme           # set in ZAP → Tools → Options → API
ZAP_SCAN_TYPE=baseline         # baseline | full | api
ZAP_FAIL_ON=high               # severity level that causes pipeline FAIL
ZAP_WARN_ON=medium             # severity level that causes WARN
ZAP_MAX_ISSUES=0               # 0 = unlimited
SEC_STORY_DESCRIPTION=         # optional text injected into security agent
```

### Server Startup Validation

`src/main.js` validates at startup and calls `process.exit(1)` if:
- `JIRA_URL` is missing or not a valid URL
- `JIRA_EMAIL` is missing
- `JIRA_API_TOKEN` is missing

---

## 5. AI Agent Pipeline

### 5.1 Planner Agent (`src/agents/planner.agent.js`)

Analyses the Jira story's text fields (summary, description, acceptance criteria) using multi-layer keyword NLP — **no external LLM required**.

**Output:**
```js
{
  scope:              "Employee Creation in OrangeHRM",
  testTypes:          ["Happy Path", "Negative", "UI Validation", "Security", "Boundary"],
  designTechniques:   ["Equivalence Partitioning", "Error Guessing", "Boundary Value Analysis"],
  criticalScenarios:  ["Verify successful ... with valid data", ...],
  risks:              ["Password storage or transmission vulnerability", ...],
  performanceRequired: false,
  securityRequired:    true,
  securityCategories:  ["A07:2021", "A01:2021"]
}
```

**Signal Maps:**
- `TYPE_SIGNALS` — 13 test type categories with keyword triggers
- `TECHNIQUE_SIGNALS` — 6 design techniques with keyword triggers
- `RISK_SIGNALS` — 9 domain patterns mapped to risk descriptions
- `CONTEXT_BOOSTERS` — deep contextual augmentation for richer scenarios

---

### 5.2 QA Agent (`src/agents/qa.agent.js`)

Generates detailed test cases from the planner output. Uses **11 static templates** plus **6 dynamic generators** based on story context.

**Each test case contains:**
- `title`, `description`
- `designTechnique` (e.g. `"Equivalence Partitioning (EP) — Valid Partition"`)
- `testData[]` — field / value / partition table
- `steps[]` → converted to GWT steps (Given/When/Then/And)
- `expected` — expected result string
- `priority` — High / Normal / Low
- `tags[]` — lowercase labels (e.g. `["happy-path", "smoke", "ep-valid"]`)

**Static Templates (11):**

| # | Template | Technique |
|---|---|---|
| 1 | Happy path — all valid inputs | EP (Valid partition) |
| 2 | Mandatory fields enforcement | EP (Invalid — empty) |
| 3 | Invalid data rejection | EP (Invalid partition) |
| 4 | Boundary value handling | BVA |
| 5 | Special characters & unicode | EG |
| 6 | Cancel / discard flow | EG |
| 7 | Data persistence after save | ST |
| 8 | Maximum records limit | BVA |
| 9 | Role-based access control | DT |
| 10 | Network resilience | EG |
| 11 | UI feedback messages | UC |

**Dynamic Generators (6):** Acceptance criteria scenarios, duplicate creation, session timeout/re-auth, concurrent access, browser navigation, copy-paste/autofill.

---

### 5.3 Reviewer Agent (`src/agents/reviewer.agent.js`)

Quality-gate that runs after QA Agent. Rules applied in order:

1. **Deduplication** — Levenshtein similarity ≥ 0.85 between titles → remove the later duplicate
2. **Minimum steps** — must have ≥ 3 steps; auto-inserts placeholder steps if short
3. **Expected result** — must be non-empty string; defaults to `"The operation completes successfully without errors."`
4. **Priority normalisation** — enforced to `High | Normal | Low`
5. **Tags** — must be array of lowercase strings

---

### 5.4 Risk Prioritizer Agent (`src/agents/riskPrioritizer.agent.js`)

Scores each test case on three dimensions (1–10 each) and reorders for risk-based execution.

**Scoring formula:**
```
riskScore = (businessImpact × 0.4) + (failureLikelihood × 0.3) + (defectSeverity × 0.3)
```

| Dimension | Driven By |
|---|---|
| Business Impact | Tag map (security=10, smoke=9, regression=8…) |
| Failure Likelihood | Tag map (concurrency=10, edge-case=9, error-guessing=8…) |
| Defect Severity | Tag map (security=10, persistence=9, happy-path=8…) |

**Context Boosters:** `login/auth` → business +2, severity +2. `payment/transaction` → both +3. `delete/remove` → severity +2.

---

### 5.5 Executor Agent (`src/agents/executor.agent.js`)

Creates each test case in Zephyr Scale and writes stub Playwright spec files.

Per test case:
1. `POST /v2/testcases` → receives `{ id, key }` (e.g. `SCRUM-T160`)
2. `generateTest(tc)` → writes `tests/generated/{name}.spec.js` stub

---

### 5.6 Orchestrator (`src/orchestrator/agentOrchestrator.js`)

```
getStory(issueKey)
  → planner.plan(story)
  → qa.generate(story, plan)
  → reviewer.review(testCases)
  → riskPrioritizer.prioritize(testCases, story)
  → executor.execute(testCases)
  → { story, testCases, createdKeys }
```

---

## 6. Performance Testing Pillar

### 6.1 Performance Agent (`src/agents/performance.agent.js`)

Analyses story for performance keywords (`load`, `latency`, `throughput`, `concurrent`, `SLA`, `stress`, `spike`, etc.) and produces a load profile and test configuration.

**Test Types and Stage Shapes:**

| Type | Stage Shape |
|---|---|
| `load` | ramp-up → sustain at VUs → ramp-down |
| `stress` | ramp-up → sustain at 2× VUs → ramp-down |
| `spike` | instant spike to 3× VUs for 1 min → drop to 0 |
| `soak` | ramp-up → sustain for `PERF_SOAK_DURATION` → ramp-down |
| `scalability` | step ramp: 10% → 50% → 100% of VUs |
| `breakpoint` | continuous ramp from 1 → 2× VUs over 10 min (k6 stops on error threshold) |

---

### 6.2 Performance Script Generator (`src/tools/perfScript.generator.js`)

Writes a valid k6 ES module to `tests/perf/<testType>/<storyKey>_<testType>.k6.js`.

Each generated script includes:
- `export const options` with `stages[]` and `thresholds`
- Custom `Trend` (response_time) and `Rate` (error_rate) metrics
- `export default function()` with `http.get`, `check()`, `sleep()`

---

### 6.3 Performance Execution Service (`src/services/perf.execution.service.js`)

| Function | Purpose |
|---|---|
| `runPerfTest(scriptPath, outJsonPath, env)` | Spawns k6 with `--out json=...` |
| `parsePerfResults(jsonPath)` | Parses k6 JSON → normalised metrics |
| `evaluateThresholds(metrics, thresholds)` | Returns `{ verdict, breaches[] }` |
| `compareBaseline(metrics, storyKey)` | Computes `changePct` vs `baselines/baseline.json` |
| `updateBaseline(metrics, storyKey)` | Writes new baseline values |
| `syncPerfResults(results, opts)` | Pushes results to Zephyr executions |

**Baseline Regression:** A p95 increase > `PERF_BASELINE_TOLERANCE` (default 20%) sets `baselineDegraded: true` in the report.

---

### 6.4 Performance Pipeline (`scripts/run-perf.js`) — 6 Stages

| Stage | Action | Skip Flag |
|---|---|---|
| 1 | Generate k6 scripts from story | `--skip-generate` |
| 2 | Execute all k6 scripts | — |
| 3 | Evaluate SLA thresholds | — |
| 4 | Sync results to Zephyr | `--skip-sync` |
| 5 | Generate Performance HTML report | `--skip-report` |
| 6 | Git commit + push | `--skip-git` |

**Additional flags:** `--test-type=load|stress|spike|soak` — run only one type.

---

## 7. Security Testing Pillar

### 7.1 Security Agent (`src/agents/security.agent.js`)

Analyses story for security keywords and maps detected signals to OWASP Top 10 (2021).

**Full OWASP Top 10 Coverage:**

| ID | Category | Custom Checks |
|---|---|---|
| A01:2021 | Broken Access Control | csrf-token-absence, idor-employee-id |
| A02:2021 | Cryptographic Failures | sensitive-data-in-response, insecure-cookie-flags |
| A03:2021 | Injection | sql-injection-signal, xss-reflection-signal |
| A04:2021 | Insecure Design | ZAP only |
| A05:2021 | Security Misconfiguration | missing-security-headers, insecure-cookie-flags |
| A06:2021 | Vulnerable & Outdated Components | ZAP only |
| A07:2021 | Identification & Authentication Failures | session-fixation, broken-auth-brute-force |
| A08:2021 | Software & Data Integrity Failures | ZAP only |
| A09:2021 | Security Logging & Monitoring Failures | ZAP only |
| A10:2021 | SSRF | open-redirect |

---

### 7.2 Security Script Generator (`src/tools/secScript.generator.js`)

Writes `tests/security/<storyKey>-scan-config.json`.

> **Security note:** `zapApiKey` is **always masked as `"***"`** in the written file — the real key is never persisted to disk.

---

### 7.3 Security Execution Service (`src/services/sec.execution.service.js`)

| Function | Purpose |
|---|---|
| `startZap()` | Start ZAP via Docker or detect running daemon |
| `stopZap()` | Stop ZAP daemon |
| `runSpider(url)` | Trigger ZAP spider, poll to 100% |
| `runActiveScan(url)` | Trigger active scan, poll to 100% |
| `getAlerts(url)` | Fetch all alerts from ZAP API |
| `runCustomChecks(url, checkNames)` | Execute each custom check via HTTP assertions |
| `parseFindings(zapReportPath, customResults)` | Merge ZAP + custom findings, normalise severity |
| `evaluateSeverity(findings, severityPolicy)` | Return `{ verdict: pass\|warn\|fail, counts }` |
| `syncSecResults(findings, opts)` | Push results to Zephyr |

**Custom Checks:**

| Check Name | Verifies |
|---|---|
| `missing-security-headers` | X-Frame-Options, X-Content-Type-Options, CSP, HSTS presence |
| `insecure-cookie-flags` | `Set-Cookie` headers contain `HttpOnly` and `Secure` |
| `csrf-token-absence` | POST forms include a CSRF token |
| `sensitive-data-in-response` | Response bodies don't expose passwords/tokens |
| `sql-injection-signal` | Error messages don't contain SQL syntax hints |
| `xss-reflection-signal` | Injected strings are not reflected unescaped |
| `session-fixation` | Session ID changes after login |
| `open-redirect` | Redirect parameters are validated |

---

### 7.4 Security Pipeline (`scripts/run-security.js`) — 7 Stages

| Stage | Action | Skip Flag |
|---|---|---|
| 1 | Generate ZAP scan config | `--skip-generate` |
| 2 | Start / verify ZAP daemon | `--no-zap` |
| 3 | Run ZAP spider + active scan | `--no-zap` |
| 4 | Run custom OWASP checks | — |
| 5 | Evaluate findings + severity policy | — |
| 6 | Sync to Zephyr / create Jira bugs | `--skip-sync`, `--skip-bugs` |
| 7 | Generate Security HTML report + git push | `--skip-report`, `--skip-git` |

---

## 8. Test Framework

### Application Under Test

**OrangeHRM** — `https://opensource-demo.orangehrmlive.com`  
Module: **PIM → Add Employee**  
Credentials: `Admin` / `admin123`

### Playwright Configuration (`playwright.config.js`)

| Setting | Value | Env Override |
|---|---|---|
| `testDir` | `./tests/specs` | — |
| `timeout` | 90,000 ms | — |
| `retries` | 1 | — |
| `workers` | 3 | `PW_WORKERS` |
| `fullyParallel` | true | — |
| `baseURL` | `https://opensource-demo.orangehrmlive.com` | — |
| `headless` | false | `PW_HEADLESS=true` |
| `screenshot` | `only-on-failure` | — |
| `video` | `retain-on-failure` | — |
| `trace` | `retain-on-failure` | — |
| `slowMo` | 50 ms (headed) / 0 ms (headless) | — |
| `grep` | — | `PW_GREP=<regex>` |

**Reporters:** `list`, `json` → `test-results.json`, `html` → `playwright-report/`, `allure-playwright` → `allure-results/`

### Global Setup (`tests/global-setup.js`)

Runs **once** before all tests:
1. `ensureDirs()` — create all output directories
2. `cleanDir('allure-results')` — clear stale Allure results
3. `cleanDir('test-results/screenshots')` — clear stale screenshots
4. Health-check OrangeHRM (`GET /web/index.php/auth/login`) — fail fast if unreachable
5. Authenticate and cache `storageState` in `.auth/storage-state.json`

### Spec File Naming Convention

```
tests/specs/SCRUM-T{n}_{title_slug}.spec.js
```

The TC key is extracted by `run-and-sync.js` using `filename.match(/^(SCRUM-T\d+)_/i)`.

---

## 9. Page Object Model (POM)

All POM classes load their selectors from `.yml` files via `tests/helpers/locatorLoader.js`, keeping CSS selectors fully external to the JavaScript code.

### LoginPage (`tests/pages/LoginPage.js`)

| Method | Action |
|---|---|
| `goto()` | Navigate to `/web/index.php/auth/login`, wait for username input |
| `login(username, password)` | Fill, click, wait for `**/dashboard**` |
| `getErrorMessage()` | Returns error alert text or `null` |

**LoginPage.yml selectors:**
```yaml
usernameInput: 'input[name="username"]'
passwordInput: 'input[name="password"]'
loginButton:   'button[type="submit"]'
errorAlert:    '.oxd-alert--error'
```

### AddEmployeePage (`tests/pages/AddEmployeePage.js`)

| Method | Action |
|---|---|
| `navigate()` | Go to `/web/index.php/pim/addEmployee` |
| `fillEmployee({ firstName, middleName, lastName })` | Fill name fields |
| `save()` | Click Save button |
| `getEmployeeId()` | Return generated Employee ID |

### EmployeeListPage (`tests/pages/EmployeeListPage.js`)

| Method | Action |
|---|---|
| `navigate()` | Go to employee list |
| `search(name)` | Fill search field and click Search |
| `getResults()` | Return array of employee names from results table |

---

## 10. Fixture System & ScreenshotHelper

### Base Fixture (`tests/fixtures/base.fixture.js`)

Extends Playwright's `test` with composed fixtures and full lifecycle hooks.

**Fixtures provided:**

| Fixture | Type | Description |
|---|---|---|
| `loginPage` | `LoginPage` | POM instance |
| `addEmployeePage` | `AddEmployeePage` | POM instance |
| `employeeListPage` | `EmployeeListPage` | POM instance |
| `sh` | `ScreenshotHelper` | Step-level screenshot capturer |
| `uniqueSuffix` | `string` | Last 5 digits of `Date.now()` for unique test data |

**Lifecycle Hooks:**

| Hook | Action |
|---|---|
| `beforeAll` | Log suite start with timestamp |
| `beforeEach` | Clear cookies for test isolation |
| `afterEach` | On failure: screenshot + console errors + dismiss dialogs. Always: log result + duration |
| `afterAll` | Log suite summary (pass/fail counts) |

**Usage:**
```js
const { test, expect } = require('../fixtures/base.fixture');

test('my test', async ({ page, loginPage, addEmployeePage, sh, uniqueSuffix }, testInfo) => {
  await sh.step('Open Login Page', async () => {
    await loginPage.goto();
  });
});
```

---

### ScreenshotHelper (`tests/helpers/screenshot.helper.js`)

Wraps every test step with automatic screenshot capture.

**`sh.step(label, async () => { ... })`**
- Wraps actions in a named `test.step()` block
- Takes full-page screenshot **after** step actions complete
- Saves to: `test-results/screenshots/<test-slug>/step-{n:02}-{label}.png`
- Attaches to `testInfo` → visible in both Allure and Playwright HTML reports

**`sh.capture(label)`**
- Standalone screenshot at any point outside a step block

---

## 11. Self-Healing Agent

**Script:** `scripts/healer.js`

Automatically classifies test failures, patches spec files, and re-runs repaired tests.

### Stages

| Stage | Action |
|---|---|
| 0 | Run full Playwright suite (skip with `--skip-run` or `HEALER_SKIP_RUN=true`) |
| 1 | Read `test-results.json` → identify all failing tests |
| 2 | Classify failure type → apply healing patch to spec file |
| 3 | Re-run healed specs only |
| 4 | Print summary → save `test-results-healed.json` |

### Healing Strategies

| Error Type | Patch Applied |
|---|---|
| `timeout` | Extend timeout to 60 s + add `waitForLoadState('networkidle')` |
| `strict_mode` | Add `.first()` to ambiguous multi-match locators |
| `not_visible` | Add `.waitFor({ state: 'visible' })` guard before interactions |
| `navigation` | Switch to `domcontentloaded` + networkidle wait |
| `selector` | Extend `waitForURL` timeout + add networkidle |
| `general` | Extend timeouts + networkidle (safe fallback) |

Healed specs are saved to `tests/healed/` — originals in `tests/specs/` are preserved.

### Usage

```bash
node scripts/healer.js               # run suite + heal
node scripts/healer.js --skip-run    # heal only (reuse existing results)
node scripts/healer.js --headless    # force headless browser
```

---

## 12. Pipeline Scripts Reference

### Hierarchy (highest-level to lowest)

```
run-e2e.js (15 stages)
  └─▶ run-qa-complete.js (14 stages)
        └─▶ run-full-pipeline.js (8+2 optional stages)
              ├─▶ run-perf.js (6 stages)
              └─▶ run-security.js (7 stages)
```

---

### `scripts/run-e2e.js` — Complete End-to-End (15 stages)

Single command for the full 3-pillar QA journey.

**Phase A — PREPARE:**
- Stage 1: Ensure output directories
- Stage 2: Story → Zephyr TCs *(hard-fail)*
- Stage 3: Generate Playwright specs *(hard-fail)*
- Stage 4: Generate k6 scripts
- Stage 5: Generate ZAP config

**Phase B — EXECUTE:**
- Stage 6: Run Playwright → sync Zephyr
- Stage 7: Self-Healing Agent
- Stage 8: Create Jira bugs
- Stage 9: k6 performance pipeline (`--skip-report --skip-git` internally)
- Stage 10: ZAP security pipeline (`--skip-report --skip-git` internally)

**Phase C — REPORT:**
- Stage 11: Functional HTML report
- Stage 12: Performance HTML report
- Stage 13: Security HTML report
- Stage 14: Allure report
- Stage 15: Git commit + push

All stages except 2 and 3 soft-fail (pipeline continues on error).

**Flags:**
```
--headless        Playwright headless mode
--skip-story      Skip story analysis (use existing TCs)
--skip-perf       Skip performance pillar entirely
--skip-security   Skip security pillar entirely
--no-zap          Custom checks only (no ZAP scan)
--skip-heal       Skip self-healer
--skip-bugs       Skip Jira bug creation
--skip-git        Skip git commit + push
--force           Force-recreate Zephyr TCs
```

---

### `scripts/run-qa-complete.js` — All 3 Pillars (14 stages)

Integrates all three testing pillars in a single process with in-process service calls (no child process delegation for core stages).

---

### `scripts/run-full-pipeline.js` — Functional Pipeline (8+2 stages)

8 core stages (story → specs → run → heal → bugs → report → allure → git) plus optional `--include-perf` and `--include-security` flags that add stages 3p and 3s.

---

### `scripts/run-and-sync.js` — Playwright Execution + Zephyr Sync

Internal 6-step flow:
1. Run `npx playwright test` with JSON reporter
2. Parse `test-results.json` → map spec filenames to Zephyr TC keys
3. Fetch Jira story (for cycle version/assignee traceability)
4. Create Zephyr test cycle: `AutoRun-{ISSUE_KEY}-{timestamp}`
5. Per TC: create execution → update status → link to Jira issue
6. **GET existing TC** → **PUT full body** with `automationStatus: "Automated"` (GET-then-PUT prevents field erasure)

**Console output legend:**
- `✓ PASS [Automated ✓] [Linked ✓]` — fully synced
- `⚠ [mark failed]` — TC status synced but `automationStatus` PUT failed
- `⚠ sync failed` — Zephyr API call failed entirely

---

### Building Block Scripts Summary

| Script | Key Export / Purpose |
|---|---|
| `ensure-dirs.js` | `ensureDirs()`, `cleanDir(rel)` |
| `run-story.js` | Fetch story → agents → Zephyr TCs (CLI) |
| `generate-playwright.js` | Zephyr TCs → `tests/specs/*.spec.js` (CLI) |
| `generate-perf-scripts.js` | `run()` — story → k6 scripts |
| `generate-sec-scripts.js` | `run()` — story → ZAP config |
| `healer.js` | Self-Healing Agent (CLI) |
| `create-jira-bugs.js` | Create Jira bugs for failures (CLI) |
| `generate-report.js` | Functional HTML report (CLI) |
| `generate-allure-report.js` | Allure HTML report (CLI) |
| `generate-perf-report.js` | `generatePerfReport(results, thresholds, dir)` |
| `generate-sec-report.js` | `generateSecReport(findings, checklist, dir)` |
| `git-sync.js` | `run()` — git commit + push |

---

## 13. Report Generation

### Functional Report (`custom-report/index.html`)

- Summary dashboard: pass / fail / blocked / not-executed counts + pie chart
- Per-test collapsible accordion cards (green = pass, red = fail)
- Step-by-step table with duration + badge per step
- Failure step highlighted with inline error message
- Playwright failure screenshot embedded as base64
- Video recording embedded as `<video>` (WebM)
- Step screenshots from ScreenshotHelper inline
- Link to Allure report (if `allure-report/` exists)

### Performance Report (`custom-report/perf/index.html`)

- Executive Summary cards: total scripts, SLA pass/warn/fail, worst p95, total requests
- 4-tab interface:
  1. **Response Time Charts** — Chart.js bar chart (p95/p99/avg per script)
  2. **All Scripts** — results table with verdict badges
  3. **Script Details** — expandable per-script panels
  4. **Baseline Comparison** — delta % vs previous run, regression highlighting
- Colour-coded by test type (load=blue, stress=orange, spike=red, soak=purple…)
- Chart.js 4.4.1 via CDN — fully self-contained single HTML file

### Security Report (`custom-report/security/index.html`)

- Finding Summary bar: Critical / High / Medium / Low / Informational counts
- Visual Analytics (3 charts): severity doughnut, OWASP category bar, timeline scatter
- 4-tab interface:
  1. **OWASP Coverage** — all 10 categories with status badges
  2. **All Findings** — full table with severity, OWASP ID, description
  3. **Finding Details** — expandable panels with remediation guidance
  4. **Remediation Checklist** — prioritised to-do list (Critical first)
- Overall verdict badge: PASS / WARN / FAIL

### Allure Report (`allure-report/index.html`)

Generated by `allure generate allure-results --clean -o allure-report` using `node_modules/.bin/allure`.

Includes: timeline view, test suites, categories, step-level screenshots (via `testInfo.attach()`), full history/trends.

---

## 14. Service Layer

| Service | Key Function | Description |
|---|---|---|
| `bug.service.js` | `createBugsForFailures(results, parentKey)` | Create Jira bugs for each failed test |
| `flaky.service.js` | `detectFlaky(name, passed)` | Rolling 5-run in-memory flaky detection |
| `coverage.service.js` | `calculateCoverage(testCases, story)` | Keyword-based TC↔story coverage % |
| `cycle.service.js` | `setupCycle()` / `completeCycle()` | Create + close Zephyr test cycle |
| `execution.service.js` | `runPlaywright()` | Spawn `npx playwright test` |
| `executionMapping.service.js` | `mapResults(cycleKey, keys, results, story)` | Create executions + update status + link |
| `perf.execution.service.js` | `runPerfTest()`, `evaluateThresholds()`, `compareBaseline()` | Full k6 lifecycle |
| `sec.execution.service.js` | `startZap()`, `runActiveScan()`, `runCustomChecks()`, `parseFindings()` | Full ZAP lifecycle |

**`retry.js`:** `retry(fn, retries=3, delay=1500)` — async retry with configurable attempts and delay.

---

## 15. REST API & Dashboard

Start the server: `npm run start:server` (port configured by `PORT` env var, default 3000).

### Endpoints

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/dashboard` | — | Test results summary from `test-results.json` |
| `POST` | `/api/webhook/jira` | HMAC-SHA256 | Receive Jira webhook → auto-trigger pipeline |
| `POST` | `/api/webhook/manual` | Bearer token | Manual pipeline trigger for given `issueKey` |
| `GET` | `/api/webhook/status` | Bearer token | Webhook config + recent trigger history |
| `GET` | `/api/screenshots/summary` | — | Aggregated screenshot statistics |
| `GET` | `/api/screenshots` | — | All tests + screenshot paths |
| `GET` | `/api/screenshots/:test` | — | Screenshots for a specific test |
| `GET` | `/api/screenshots/:test/:file` | — | Serve screenshot image |
| `GET` | `/api/security/summary` | — | Latest security scan summary |
| `GET` | `/api/perf/summary` | — | Aggregated performance test summary |

### Authentication

- **Webhook:** `X-Hub-Signature` HMAC-SHA256 using `WEBHOOK_SECRET` (optional)
- **Protected routes:** `Authorization: Bearer <API_SECRET>` — only enforced if `API_SECRET` is set
- **Rate limiting:** Jira webhook: 5-minute cooldown per `issueKey` (in-memory, prevents duplicate runs)

### Webhook Events

| Event | Trigger Condition |
|---|---|
| `jira:issue_created` | Project matches + issue type is Story |
| `jira:issue_updated` | Status moves to one of `WEBHOOK_TRIGGER_STATUSES` |
| `comment_created` | Comment body contains `/qa-run` |

---

## 16. Git Agent

**Script:** `scripts/git-sync.js`

### Commit Message Format

```
chore(qa-pipeline): auto-run SCRUM-5 — 14/17 passed — 2026-04-21 14:30:00
```

### Files Staged

`test-results.json`, `test-results-healed.json`, `test-results/`, `custom-report/`, `playwright-report/`, `allure-results/`, `allure-report/`, `tests/specs/`, `.story-testcases.json`, `tests/perf/`, `tests/security/`

### Safety Features

- Validates valid git repo before proceeding
- Skips commit if working tree is clean
- Uses `--no-verify` to avoid pre-commit hook blocking CI
- Soft-fails on push error (exits 0)

### Usage

```bash
node scripts/git-sync.js               # commit + push
node scripts/git-sync.js --skip-push   # commit only
node scripts/git-sync.js --dry-run     # show what would be staged
```

---

## 17. CI/CD — GitHub Actions

**Workflow:** `.github/workflows/qa.yml`  
**Triggers:** Push to `main`, manual `workflow_dispatch`

### Pipeline Steps

| Step | Action |
|---|---|
| 1 | Checkout (full history for git push back) |
| 2 | Setup Node.js 20 with npm cache |
| 3 | `npm install` |
| 4 | `npx playwright install --with-deps chromium` |
| 4b | Install k6 via APT (signed GPG repo) |
| 4c | Start OWASP ZAP Docker container (`zaproxy/zap-stable`) on port 8080 |
| 5 | `node scripts/run-qa-complete.js --headless` (`continue-on-error: true`) |
| 6–9 | Upload `playwright-report/`, `custom-report/`, `custom-report/perf/`, `custom-report/security/` artifacts (30 days) |
| 8–9 | Upload `allure-results/`, `allure-report/` artifacts |
| 10 | `git commit [skip ci] && git push` all generated artifacts back to `main` |

### GitHub Secrets Required

| Secret | Purpose |
|---|---|
| `JIRA_URL` | Jira instance URL |
| `JIRA_EMAIL` | Jira user email |
| `JIRA_API_TOKEN` | Jira API token |
| `ISSUE_KEY` | Story key (e.g. `SCRUM-5`) |
| `PROJECT_KEY` | Project key (e.g. `SCRUM`) |
| `ZEPHYR_BASE_URL` | Zephyr API base URL |
| `ZEPHYR_ACCESS_KEY` | Zephyr JWT access key |
| `ZAP_API_KEY` | ZAP API key |
| `APPLITOOLS_API_KEY` | Applitools visual AI key (optional) |

### CI-Specific Overrides

```yaml
PW_HEADLESS:    'true'    # headless browser
PERF_SKIP_SOAK: 'true'    # soak tests too long for CI
PERF_VUS_MAX:   '10'      # cap virtual users in CI
ZAP_SCAN_TYPE:  'baseline' # faster ZAP scan mode
ZAP_FAIL_ON:    'high'    # only fail on High+ severity
```

---

## 18. npm Scripts Reference

### End-to-End (All 3 Pillars)

| Script | Description |
|---|---|
| `npm run e2e` | Full 15-stage E2E (all 3 pillars, headed browser) |
| `npm run e2e:headed` | Same — headed browser (default) |
| `npm run e2e:headless` | All 3 pillars, headless / CI mode |
| `npm run e2e:ci` | Headless + skip git push |
| `npm run e2e:functional` | Functional pillar only (skip perf + security) |
| `npm run e2e:no-perf` | Skip performance pillar |
| `npm run e2e:no-security` | Skip security pillar |

### Pipeline

| Script | Description |
|---|---|
| `npm start` | 8-stage functional pipeline |
| `npm run qa:complete` | 14-stage all-3-pillars |
| `npm run qa:complete:headless` | 14-stage all-3-pillars, headless |
| `npm run qa:full` | QA runner + perf + security |

### Functional Testing

| Script | Description |
|---|---|
| `npm test` | Run all Playwright specs |
| `npm run qa` | Lightweight QA runner |
| `npm run qa:run` | Run specs only (no generation) |
| `npm run qa:generate` | Generate specs only (skip story) |

### Performance

| Script | Description |
|---|---|
| `npm run perf` | Full 6-stage k6 pipeline |
| `npm run perf:load` | Load test only |
| `npm run perf:stress` | Stress test only |
| `npm run perf:spike` | Spike test only |
| `npm run perf:soak` | Soak test only |
| `npm run perf:generate` | Generate k6 scripts only |
| `npm run perf:report` | Generate performance HTML report only |

### Security

| Script | Description |
|---|---|
| `npm run security` | Full 7-stage security pipeline |
| `npm run security:no-zap` | Custom checks only (no ZAP) |
| `npm run security:generate` | Generate ZAP config only |
| `npm run security:report` | Generate security HTML report only |

### Reports & Server

| Script | Description |
|---|---|
| `npm run report` | Generate functional HTML report |
| `npm run report:allure` | Generate Allure HTML report |
| `npm run allure:open` | Open Allure report in browser |
| `npm run start:server` | Start Express REST API (port 3000) |

---

## 19. Quick Start Guide

### Prerequisites

- **Node.js 20+**
- **k6** — `choco install k6` (Windows) / `brew install k6` (macOS) / apt (Linux)
- **OWASP ZAP** — optional, only needed for full security pillar
- **Git** configured with push access to the repository

### Setup

```bash
# 1. Clone and install
git clone <repo-url>
cd AAFAgentic-QAPlatform-AutomationAndPerformance
npm install
npx playwright install --with-deps chromium

# 2. Configure
cp .env.example .env
# Edit .env — set JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN, ZEPHYR_ACCESS_KEY, ISSUE_KEY

# 3. Validate connectivity (optional but recommended)
node scripts/diag-zephyr.js
node scripts/validate-integration.js
```

### Run Commands

```bash
# Full end-to-end (all 3 pillars, headed browser)
npm run e2e

# Full end-to-end (headless — CI mode)
npm run e2e:headless

# Functional pillar only
npm run e2e:functional

# Performance tests only (load + stress + spike)
npm run perf

# Security checks only (no ZAP — custom checks only)
npm run security:no-zap

# Run existing Playwright specs directly
npm test

# Open the Allure interactive report
npm run allure:open

# Start the REST API + dashboard
npm run start:server
# → http://localhost:3000/api/dashboard
```

### Common Flag Combinations

```bash
# Skip git push (local development)
node scripts/run-e2e.js --skip-git

# Reuse existing Zephyr TCs (skip story analysis)
node scripts/run-e2e.js --skip-story

# Force-recreate all Zephyr TCs
node scripts/run-e2e.js --force

# Skip self-healer for faster run
node scripts/run-e2e.js --skip-heal

# Run only load test, skip reporting and git
node scripts/run-perf.js --test-type=load --skip-report --skip-git

# Security custom checks only, no ZAP, no git
node scripts/run-security.js --no-zap --skip-git
```

---

## 20. Troubleshooting

### `[mark failed]` appears in Zephyr sync output

**Meaning:** The `PUT /testcases/{key}` call to set `automationStatus: "Automated"` failed.  
**Why it happens:** Zephyr's PUT endpoint requires a full-body replacement. The fix in `run-and-sync.js` does GET-then-PUT to preserve all existing fields.  
**If still occurring:** Check that `ZEPHYR_ACCESS_KEY` has "Edit Test Cases" permission scope in Jira → Apps → Zephyr Essentials → API Keys.

---

### `JIRA_URL is not set` on server start

Add `JIRA_URL=https://your-org.atlassian.net/` to `.env`. The server validates this before starting and will exit with a descriptive error message.

---

### `k6: command not found` / `ENOENT`

Install k6 and ensure it is on `PATH`, or set `PERF_K6_BINARY=/full/path/to/k6` in `.env`.

---

### ZAP: `connection refused` on security pipeline Stage 2

**Option A — Manual start:**
```bash
zap.sh -daemon -host 0.0.0.0 -port 8080 -config api.key=changeme
```
**Option B — Docker auto-start:** Set `ZAP_DOCKER=true` in `.env` — the pipeline pulls and starts ZAP automatically.  
**Option C — Skip ZAP entirely:** Use `--no-zap` flag — custom OWASP checks still run.

---

### Allure report is empty after the test run

`global-setup.js` cleans `allure-results/` before each run. If results are still empty after running, verify:
1. `allure-playwright` is in `devDependencies` (`npm install`)
2. `allure-playwright` reporter is listed in `playwright.config.js` reporters array
3. The `resultsDir` option is set to `'allure-results'` (v3 uses `resultsDir`, not `outputFolder`)

---

### Tests always fail at login

OrangeHRM demo (`opensource-demo.orangehrmlive.com`) is a shared public environment. If the admin password has been changed by another user, check the site directly and restore or update `CREDENTIALS.admin.password` in `tests/data/testData.js`.

---

### Performance tests produce no output JSON

- Verify k6 is v0.43+ (`k6 version` should show `v0.43.0` or later)
- Ensure `test-results/perf/` exists (`node scripts/ensure-dirs.js`)
- Check that the k6 script was generated (`tests/perf/load/*.k6.js`)
- Run with verbose output: `k6 run --out json=out.json tests/perf/load/SCRUM-5_load.k6.js`

---

### Git push rejected in CI

The workflow uses `contents: write` permission and the `GITHUB_TOKEN`. The commit message includes `[skip ci]` to prevent re-triggering the workflow. If push is still rejected, check branch protection rules — ensure the `github-actions[bot]` is allowed to bypass push rules.

---

### `OPENAI_API_KEY` not set warning

This is safe to ignore. The OpenAI utility (`src/utils/openai.js`) is present but **none of the agents use it** — all agents are rule-based and require no external LLM. Remove the key from `.env.example` concern by leaving `OPENAI_API_KEY=` empty.

---

*End of Documentation — Agentic QA Platform v2.0.0 — April 21, 2026*
