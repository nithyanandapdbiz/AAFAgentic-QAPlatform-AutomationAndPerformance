# Agentic QA Platform — Detailed Solution Documentation

> **End-to-end, AI-agent-driven QA automation for Jira + Zephyr Scale + Playwright + k6 + OWASP ZAP + Nuclei/SQLMap/ffuf, with reactive and proactive self-healing.**
>
> _Updated: April 2026 · Node ≥ 18 · CommonJS · Target AUT: OrangeHRM open-source demo_

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Repository Layout](#3-repository-layout)
4. [Package Metadata & Scripts](#4-package-metadata--scripts)
5. [Backend (`src/`)](#5-backend-src)
    - 5.1 [Agents (`src/agents/`)](#51-agents-srcagents)
    - 5.2 [REST API (`src/api/`)](#52-rest-api-srcapi)
    - 5.3 [Core (`src/core/`)](#53-core-srccore)
    - 5.4 [Orchestrator (`src/orchestrator/`)](#54-orchestrator-srcorchestrator)
    - 5.5 [Services (`src/services/`)](#55-services-srcservices)
    - 5.6 [Tools & Clients (`src/tools/`)](#56-tools--clients-srctools)
    - 5.7 [Utilities (`src/utils/`)](#57-utilities-srcutils)
    - 5.8 [Pipeline Package (`src/pipeline/`)](#58-pipeline-package-srcpipeline)
    - 5.9 [Server Entry (`src/main.js`)](#59-server-entry-srcmainjs)
6. [Test Suite (`tests/`)](#6-test-suite-tests)
7. [Operational Scripts (`scripts/`)](#7-operational-scripts-scripts)
8. [Pipelines & Runners](#8-pipelines--runners)
9. [Self-Healing Subsystem](#9-self-healing-subsystem)
10. [Performance Testing Subsystem](#10-performance-testing-subsystem)
11. [Security Testing Subsystem](#11-security-testing-subsystem)
12. [Penetration Testing Subsystem](#12-penetration-testing-subsystem)
13. [Reporting & Dashboard](#13-reporting--dashboard)
14. [CI/CD — GitHub Actions](#14-cicd--github-actions)
15. [Configuration Reference](#15-configuration-reference)
16. [External Integrations](#16-external-integrations)
17. [End-to-End Execution Flows](#17-end-to-end-execution-flows)
18. [Extending the Platform](#18-extending-the-platform)
19. [Observability & Schema Contracts](#19-observability--schema-contracts)
20. [Error Taxonomy & Recovery Hints](#20-error-taxonomy--recovery-hints)
21. [Operational Runbook](#21-operational-runbook)

---

## 1. Executive Summary

The **Agentic QA Platform** is an enterprise-grade automation pipeline that turns a single Jira user story into a fully executed, triaged, self-healed, and reported quality assurance run across **four testing pillars**:

| Pillar | Tooling | Agent |
|---|---|---|
| **Functional** | Playwright + Page Object Model | `planner` → `qa` → `reviewer` → `riskPrioritizer` → `executor` |
| **Performance** | k6 (`load`, `stress`, `spike`, `soak`, `scalability`, `breakpoint`) | `performance.agent` + `perfScript.generator` |
| **Security** | OWASP ZAP (docker / API) + 18 custom checks | `security.agent` + `secScript.generator` |
| **Penetration** | Nuclei CVE scan + SQLMap injection + ffuf endpoint fuzzing + ZAP-Auth | `pentest.agent` + `run-pentest.js` |

**Key properties**

- **Rule-based agents** (no external LLM required) — keyword analysis, design-technique heuristics, and Levenshtein similarity drive test design.
- **Full traceability** — Jira story → Zephyr test cases → Playwright specs → execution results → Zephyr cycle → Jira bug tickets → git commit → PR comment.
- **Three-tier healing** — reactive ([`healer.js`](scripts/healer.js)), proactive structural ([`smart-healer.js`](scripts/smart-healer.js)), and pre-run locator repair ([`proactive-healer.js`](scripts/proactive-healer.js)).
- **Enterprise reports** — custom HTML ([custom-report/](custom-report/)), Allure ([allure-report/](allure-report/)), Playwright native ([playwright-report/](playwright-report/)), plus performance, security, and pentest dashboards.
- **CI/CD** — three GitHub Actions workflows cover push, PR, and manual triggers.
- **`--skip-pentest` / `PENTEST_ENABLED`** safety gate — penetration testing only activates when explicitly enabled; all parent pipelines pass `--skip-pentest` to security sub-calls to prevent double-execution.

---

## 2. High-Level Architecture

```
+----------------------------------------------------------------------+
|                       JIRA   (story trigger)                         |
|                         |                                            |
|                         v                                            |
|  +---------------------------------------------------------------+   |
|  |   AGENT PIPELINE (src/orchestrator/agentOrchestrator.js)      |   |
|  |                                                               |   |
|  |  Jira -> Planner -> QA -> Reviewer -> RiskPrioritizer ->Exec  |   |
|  |                              |                          |    |   |
|  |                    pentest.agent                    ZEPHYR    |   |
|  +---------------------------------------------------------------+   |
|                         |                                            |
|                         v                                            |
|  +--------------+-----------------+--------------+--------------+   |
|  v              v                 v              v              v   |
| PLAYWRIGHT      k6 (perf)      OWASP ZAP      NUCLEI/          HEALING|
|  tests/specs/   tests/perf/    tests/security/ SQLMAP/ffuf      scripts/|
|                                                run-pentest.js   *healer|
|     |              |                  |              |              |   |
|     +--------------+-------+----------+--------------+             |   |
|                            v                                       |   |
|                    EXECUTION RESULTS                               |   |
|          (test-results*.json, k6 json, ZAP xml, pentest json)     |   |
|                            |                                       |   |
|          +-----------------+-----------------+------------------+  |   |
|          v                 v                 v                 v  |   |
|     Custom HTML         Allure           Pentest HTML    Dashboard |   |
|     generate-report  generate-allure  generate-pentest   src/api/ |   |
|          |                 |                 |                |   |   |
|          +-----------------+-----------------+               |   |   |
|                            v                                     |   |
|             JIRA BUGS + ZEPHYR CYCLE + GIT SYNC + PR COMMENT    |   |
+----------------------------------------------------------------------+
```

---

## 3. Repository Layout

| Folder / File | Purpose |
|---|---|
| [`.auth/`](.auth/) | Cached Playwright `storageState.json` (gitignored) |
| `.env` / [`.env.example`](.env.example) | Runtime secrets and SLA knobs |
| [`MIGRATION.md`](MIGRATION.md) | Deprecation schedule for legacy pipeline scripts. Lists removal targets, replacement commands, and migration instructions. |
| [`.eslintrc.json`](.eslintrc.json) | Lint rules (strict mode, `const`/`let`, `eqeqeq`) |
| [`.github/`](.github/) | CI/CD workflows |
| `.story-testcases.json` | Auto-cached Zephyr → story mapping |
| [`Agentic_QA_Platform_Documentation.md`](Agentic_QA_Platform_Documentation.md) | This document |
| [`allure-report/`](allure-report/) | Allure interactive HTML |
| [`allure-results/`](allure-results/) | Raw Allure result JSONs from `allure-playwright` reporter |
| [`custom-report/`](custom-report/) | Self-contained HTML reports: `index.html` (functional), `perf/`, `security/`, `pentest/`, `applitools-report.html` |
| [`dashboard/`](dashboard/) | React dashboard (standalone npm package) |
| [`heal-artifacts/`](heal-artifacts/) | Baselines, diff masks, change manifest, heal report |
| [`logs/`](logs/) | Winston logs, `agent-decisions.json`, `deprecation-warnings.log`, `pipeline-failure-report.{json,md}`, `preflight-report.json`, `secret-access.log`, `cleanup-report.json`, `.pipeline.lock` |
| `node_modules/` | NPM deps |
| [`package.json`](package.json) | Scripts, deps, engines |
| [`playwright-report/`](playwright-report/) | Built-in Playwright HTML report |
| [`playwright.config.js`](playwright.config.js) | Playwright config |
| [`README.md`](README.md) | Project quick-start |
| [`scripts/`](scripts/) | All CLI entry points |
| [`src/`](src/) | Backend server + agent layer |
| [`test-results/`](test-results/) | Playwright outputs, per-test screenshots |
| `test-results.json` / `test-results-healed.json` | Raw and post-heal Playwright JSON |
| [`tests/`](tests/) | Specs, POM, helpers, fixtures, perf, security, healed |

---

## 4. Package Metadata & Scripts

[`package.json`](package.json) — **`agentic-qa-platform` v1.0.0 (CommonJS, Node >= 18)**

### Runtime dependencies

| Package | Purpose |
|---|---|
| `axios ^1.6.0` | HTTP client (Jira, Zephyr, ZAP) |
| `dotenv ^16.0.0` | `.env` loading |
| `express ^4.18.2` | REST API server |
| `form-data ^4.0.5` | Multipart uploads (attachments) |
| `pixelmatch ^7.1.0` | Pixel-level visual diffing |
| `pngjs ^7.0.0` | PNG decoding for diffing |
| `winston ^3.10.0` | Structured logging |

### Dev dependencies

| Package | Purpose |
|---|---|
| `@playwright/test ^1.40.0` | Browser automation framework |
| `allure-commandline ^2.38.1` | Allure HTML report generator |
| `allure-playwright 3.6.0` | Playwright-to-Allure reporter |

### NPM scripts (grouped)

| Group | Scripts |
|---|---|
| **Server** | `start`, `start:server` |
| **Raw tests** | `test`, `qa`, `qa:run`, `qa:generate`, `qa:full` |
| **Reports** | `report`, `report:allure`, `allure:open` |
| **Functional pillar** | `functional`, `functional:headless`, `functional:ci` |
| **Performance pillar** | `perf`, `perf:load`, `perf:stress`, `perf:spike`, `perf:soak`, `perf:generate`, `perf:report`, `perf:dry-run`, `perf:only`, `perf:only:load`, `perf:only:stress`, `perf:only:spike`, `perf:only:soak`, `qa:with-perf` |
| **Security pillar** | `security`, `security:no-zap`, `security:generate`, `security:report`, `security:only`, `security:only:no-pentest`, `security:only:no-zap`, `qa:with-security` |
| **Penetration pillar** | `pentest`, `pentest:headless`, `pentest:dry-run`, `pentest:nuclei`, `pentest:sqlmap`, `pentest:ffuf`, `pentest:report`, `pentest:ci` |
| **Non-functional** | `nonfunctional`, `nonfunctional:perf-only`, `nonfunctional:security-only`, `nonfunctional:pentest-only`, `nonfunctional:no-pentest`, `nonfunctional:no-zap` |
| **Combined** | `qa:complete`, `qa:complete:headless`, `e2e`, `e2e:headed`, `e2e:headless`, `e2e:no-perf`, `e2e:no-security`, `e2e:no-pentest`, `e2e:functional`, `e2e:ci` |
| **Tag-scoped** | `tag`, `tag:smoke`, `tag:regression`, `tag:bva`, `tag:negative`, `tag:list` |
| **Pipeline (consolidated runner)** | `pipeline:full`, `pipeline:functional` |
| **Healing** | `heal:classify`, `heal:visual`, `heal:dom`, `heal:api`, `heal:smart`, `heal:full`, `heal:dry-run`, `heal:update-baseline` |
| **Diagnostics** | `preflight`, `cleanup:dry-run`, `cleanup:artifacts`, `cleanup:artifacts:aggressive` |

---

## 5. Backend (`src/`)

### 5.1 Agents (`src/agents/`)

All agents are **rule-based** (keyword + context heuristics — no LLM calls).

| Agent | File | Responsibility |
|---|---|---|
| **Planner** | [src/agents/planner.agent.js](src/agents/planner.agent.js) | Reads Jira story, outputs `{ scope, testTypes[], designTechniques[], criticalScenarios[], risks[], confidence }`. Uses a **weighted keyword registry** scored per category and normalised to `0..1`; categories below `AGENT_CONFIDENCE_THRESHOLD` (default `0.4`) are dropped. Design techniques: **BVA**, **EP**, **DT**, **ST**, **EG**, **UC**. |
| **QA** | [src/agents/qa.agent.js](src/agents/qa.agent.js) | Generates `{ title, description, steps[], gwt[], priority, tags[] }` test cases. Emits **Given/When/Then/And** GWT lines. **Fallback path**: when `plan.confidence < AGENT_CONFIDENCE_THRESHOLD`, always injects Happy Path + Negative + Boundary safety-net cases. |
| **Reviewer** | [src/agents/reviewer.agent.js](src/agents/reviewer.agent.js) | Quality gate: Levenshtein-similarity dedup (>= 0.85), >= 3 steps per case, non-empty expected results, priority normalisation, lowercase tag arrays. |
| **Risk Prioritizer** | [src/agents/riskPrioritizer.agent.js](src/agents/riskPrioritizer.agent.js) | Scores each case on **Business Impact**, **Failure Likelihood**, **Defect Severity** (1–10). Composite score drives execution order. |
| **Executor** | [src/agents/executor.agent.js](src/agents/executor.agent.js) | Persists each test case to Zephyr (`POST /testcases`) and generates the matching Playwright spec. Per-case try/catch. Returns `{ createdKeys[] }`. |
| **Performance** | [src/agents/performance.agent.js](src/agents/performance.agent.js) | Detects perf signals (`load`, `latency`, `concurrent`, `sla`, `stress`, `volume`, `scalability`) → emits stages, thresholds, VU profiles. Feeds `perfScript.generator`. |
| **Security** | [src/agents/security.agent.js](src/agents/security.agent.js) | Detects security signals → maps to **OWASP Top 10 2021**, emits ZAP scan config + custom checks. |
| **Pentest** | [src/agents/pentest.agent.js](src/agents/pentest.agent.js) | Rule-based NLP — detects tool-signal keywords and emits a structured `pentestPlan` (tools, nuclei tags/severities, endpoint paths, OWASP categories, risk level, estimated duration). |
| **Decision Log** | [src/agents/agentDecisionLog.js](src/agents/agentDecisionLog.js) | Fail-safe append-only observability store. Calls `logDecision(agentName, input, output, reasoning)` → `logs/agent-decisions.json` (cap: 2000 entries). Never throws. |

**Schema validation.** Every agent validates its output against [src/core/schemas.js](src/core/schemas.js) before returning. Invalid outputs are **sanitised** (not thrown) so one broken case cannot fail the whole run.

#### 5.1.1 Planner weighted keyword registry

The planner loads a single in-memory table where each row binds a lowercase keyword to a **weight** (`1` = weak hint, `2` = strong hint, `3` = explicit requirement) and a **category** (one of: `happyPath`, `negative`, `edgeCase`, `uiValidation`, `security`, `boundary`, `integration`, `performance`, `accessibility`, `rbac`).

**Scoring pipeline:**

1. Concatenate `summary + description + acceptance criteria` into a single lowercase blob.
2. For each row, if `blob.includes(keyword)` add `weight` to `categoryScores[category]`.
3. Compute `topScore = max(categoryScores)` (guard against zero).
4. Normalise each category to `confidence = categoryScore / topScore` (range `0–1`).
5. Drop categories whose `confidence < AGENT_CONFIDENCE_THRESHOLD` (default `0.4`).
6. Emit `plan.confidence = average(kept confidences)` and `plan.testTypes = keptCategories`.

#### 5.1.2 QA low-confidence fallback

When `plan.confidence < AGENT_CONFIDENCE_THRESHOLD` **or** no test cases would otherwise be generated, the QA agent always injects a **safety-net trio**:

| Fallback case  | Priority | Technique | Tag         |
|----------------|----------|-----------|-------------|
| Happy Path     | High     | EP        | `fallback`  |
| Negative       | High     | EP        | `fallback`  |
| Boundary       | Normal   | BVA       | `fallback`  |

Each fallback case carries GWT lines derived from the story subject and is then passed back through the normal reviewer + risk-prioritiser pipeline. The decision log records `fallbackApplied: true` with the triggering confidence value.

#### 5.1.3 Pentest Agent — `pentest.agent.js`

`pentest.agent.plan(story)` is a **pure rule-based NLP function** — it reads the Jira story text (summary + ADF description + acceptance criteria), matches against two signal maps, and emits a `pentestPlan` object that drives the 10-stage [`run-pentest.js`](scripts/run-pentest.js) pipeline.

**Tool signal map — `TOOL_SIGNALS`:**

| Tool | Signal keywords |
|---|---|
| `nuclei` | cve, vulnerability, exploit, dependency, component, library, patch, outdated, known issue |
| `sqlmap` | database, sql, query, search, filter, input, form, parameter, login, authentication, report |
| `ffuf` | api, endpoint, route, path, directory, admin, upload, file, backup, configuration, hidden |
| `zap-auth` | authenticated, logged in, session, role, permission, access control, authorisation, rbac |

`nuclei` is always included as the baseline scanner regardless of signal matches.

**Nuclei tag map — `NUCLEI_TAG_SIGNALS`:**

| Tag | Signal keywords |
|---|---|
| `cve` | cve, known vulnerability, patch, outdated |
| `sqli` | sql, database, injection, query |
| `xss` | script, html, reflect, dom, sanitise |
| `auth` | login, authentication, session, token, jwt |
| `exposure` | expose, leak, sensitive, credential, secret |
| `misconfig` | configuration, header, cors, tls, ssl, default |
| `lfi` | file, path, directory, include, upload, traversal |
| `ssrf` | redirect, url, fetch, proxy, callback, webhook |
| `rce` | execute, command, shell, eval, code, expression |
| `takeover` | subdomain, dns, host, vhost, cname |

If no tags match, defaults are `misconfig, exposure`. Default severities: `critical, high, medium`.

**Endpoint path extraction:** `extractEndpointPaths(text)` parses the story text for URL-like patterns starting with `/api`, `/admin`, `/user`, `/auth`, `/login`, `/search`, `/report`, `/upload`, `/export`, `/import`, `/config`, `/data`, `/v<N>`. Always includes `/` as the root. Capped at 10 endpoints.

**`pentestPlan` output schema:**

```js
{
  storyKey:               string,     // e.g. 'SCRUM-5'
  targetUrl:              string,     // PENTEST_TARGET_URL || BASE_URL
  allowedHosts:           string[],   // PENTEST_ALLOWED_HOSTS split by comma
  toolsRequired:          string[],   // ['nuclei', 'sqlmap', 'ffuf', 'zap-auth']
  nucleiTags:             string[],   // e.g. ['cve', 'auth', 'misconfig']
  nucleiSeverities:       string[],   // ['critical', 'high', 'medium']
  endpointPaths:          string[],   // ['/api/...', '/login', '/']
  owaspCategories:        string[],   // e.g. ['A03:2021', 'A07:2021']
  riskLevel:              string,     // 'low' | 'medium' | 'high' | 'critical'
  estimatedDurationMins:  number,
}
```

### 5.2 REST API (`src/api/`)

Mounted by [src/main.js](src/main.js) on `PORT` (default `3000`).

| File | Responsibility |
|---|---|
| [src/api/routes.js](src/api/routes.js) | Express `Router`. Optional `API_SECRET` bearer-token middleware on sensitive endpoints. |
| [src/api/dashboard.controller.js](src/api/dashboard.controller.js) | `GET /dashboard` — aggregated pass/fail summary. |
| [src/api/webhook.controller.js](src/api/webhook.controller.js) | `POST /webhook/jira` (HMAC-SHA256 via `WEBHOOK_SECRET`), `POST /webhook/manual`, `GET /webhook/status`. Filters by project/issuetype/status, then spawns `scripts/run-full-pipeline.js`. |
| [src/api/screenshot.controller.js](src/api/screenshot.controller.js) | `GET /screenshots/list`, `/summary`, `/by-test`, `/:filename`. |
| [src/api/security.controller.js](src/api/security.controller.js) | `GET /security/summary` — severity + OWASP aggregation. |
| [src/api/perf.controller.js](src/api/perf.controller.js) | `GET /perf/summary` — p95/p99/avg/error-rate per test-type with baseline delta. |
| [src/api/agentDecisions.controller.js](src/api/agentDecisions.controller.js) | `GET /agent-decisions?limit=N&agentName=X` (authed; `limit` 1–200; newest-first). |

### 5.3 Core (`src/core/`)

| File | Responsibility |
|---|---|
| [src/core/config.js](src/core/config.js) | Single source of truth for all `.env` values: Jira, Zephyr, SLAs, baseline tolerances, logging level, and `agent.confidenceThreshold`. |
| [src/core/errorHandler.js](src/core/errorHandler.js) | `AppError` base + subclasses: `TimeoutError`, `NonZeroExitError`, `SpawnError`, `UpstreamError`, `PreconditionError`. Each carries `code`, `status`, `recoveryHint`, `details`. |
| [src/core/schemas.js](src/core/schemas.js) | Zero-dependency validators + sanitisers for `PlannerOutput`, `QAOutput`, `ReviewerOutput`, `RiskPrioritizerOutput`, `ExecutorOutput`. |

### 5.4 Orchestrator (`src/orchestrator/`)

| File | Responsibility |
|---|---|
| [src/orchestrator/agentOrchestrator.js](src/orchestrator/agentOrchestrator.js) | `runAgentFlow(issueKey)` → Jira → `planner.plan` → `qa.generate` → `reviewer.review` → `riskPrioritizer.prioritize` → `executor.execute`. Returns `{ story, testCases, createdKeys }`. |
| [src/orchestrator/finalFlow.js](src/orchestrator/finalFlow.js) | Higher-level coordination across execute + report + sync stages. |

### 5.5 Services (`src/services/`)

| File | Responsibility |
|---|---|
| [src/services/execution.service.js](src/services/execution.service.js) | `runPlaywright()` — spawns Playwright, 10 MB buffer, `PLAYWRIGHT_EXEC_TIMEOUT_MS` (default 300 s). Classifies failures into `TimeoutError` / `SpawnError` / `NonZeroExitError`. |
| [src/services/cycle.service.js](src/services/cycle.service.js) | `setupCycle(storyKey, story)` — creates/links Zephyr test cycle. |
| [src/services/bug.service.js](src/services/bug.service.js) | `createBugsForFailures(results, parentKey)` — one Jira bug per failed test. |
| [src/services/flaky.service.js](src/services/flaky.service.js) | Sliding-window flakiness detection (last 5 of 100 runs). |
| [src/services/coverage.service.js](src/services/coverage.service.js) | Story coverage aggregation. |
| [src/services/executionMapping.service.js](src/services/executionMapping.service.js) | Playwright-test-name → Zephyr-test-case resolution. Exposes `validateMapping(storyKey)` → `{ valid, testCaseCount, missingKeys, reason? }`. |
| [src/services/perf.execution.service.js](src/services/perf.execution.service.js) | k6 spawn, JSON capture, SLA evaluation. |
| [src/services/sec.execution.service.js](src/services/sec.execution.service.js) | ZAP spawn/API interaction, findings normalisation. |

### 5.6 Tools & Clients (`src/tools/`)

| File | Responsibility |
|---|---|
| [src/tools/jira.client.js](src/tools/jira.client.js) | `getStory(key)` — full Jira issue fetch (basic auth). |
| [src/tools/jiraBug.client.js](src/tools/jiraBug.client.js) | `createBug(testResult, parentKey)` — ADF bug description, labels, "Relates" link to story. |
| [src/tools/zephyr.client.js](src/tools/zephyr.client.js) | Zephyr Essential Cloud v2.8 test-case CRUD. |
| [src/tools/zephyrCycle.client.js](src/tools/zephyrCycle.client.js) | Test-cycle lifecycle (creation, traceability, history). |
| [src/tools/zephyrExecution.client.js](src/tools/zephyrExecution.client.js) | Execution create/update (Pass/Fail/Blocked/Not Executed). |
| [src/tools/playwright.generator.js](src/tools/playwright.generator.js) | `generateTest(tc)` — Zephyr test case → Playwright spec with GWT steps, fixtures, assertions. |
| [src/tools/perfScript.generator.js](src/tools/perfScript.generator.js) | `generateK6Script(story, perf)` — k6 scripts with valid threshold syntax. |
| [src/tools/secScript.generator.js](src/tools/secScript.generator.js) | `generateSecScanConfig(story, security)` — ZAP config JSON. |

### 5.7 Utilities (`src/utils/`)

| File | Responsibility |
|---|---|
| [src/utils/logger.js](src/utils/logger.js) | Winston singleton — colourised console + `logs/app.log` + `logs/error.log`. |
| [src/utils/openai.js](src/utils/openai.js) | Optional LLM integration (OFF by default). |
| [src/utils/resultParser.js](src/utils/resultParser.js) | Normalises Playwright + k6 result shapes. |
| [src/utils/retry.js](src/utils/retry.js) | Exponential-backoff wrapper for flaky API calls. |
| [src/utils/zephyrJwt.js](src/utils/zephyrJwt.js) | `zephyrHeaders()` — builds the bearer-token header set. |

### 5.8 Pipeline Package (`src/pipeline/`)

Consolidated orchestration layer introduced to replace the copy-pasted `STAGES[]` arrays across legacy pipeline scripts.

| File | Responsibility |
|---|---|
| [src/pipeline/steps.js](src/pipeline/steps.js) | 12 named async steps: `ensureDirs`, `preFlight`, `fetchStory`, `generateSpecs`, `proactiveHeal`, `executeFunctional`, `executePerformance`, `executeSecurity`, `reactiveHeal`, `createBugs`, `generateReports`, `syncGit`. |
| [src/pipeline/runner.js](src/pipeline/runner.js) | `runPipeline(stepNames, ctx)` → `{ passed, failed, warned, skipped, steps[], halted, durationMs }`. Critical step failure halts the run and writes `logs/pipeline-failure-report.json`. |
| [src/pipeline/presets.js](src/pipeline/presets.js) | Named sequences: `functional`, `full`, `scoped` (CI), `perfOnly`, `secOnly`. |

**Opt-in from the legacy wrapper:**

```bash
node scripts/run-full-pipeline.js --use-runner --include-perf --include-security
# equivalent to:
npm run pipeline:full
```

Setting `PIPELINE_USE_RUNNER=true` in the environment has the same effect.

**Step contract:**

```js
// signature
async function stepName(ctx) { /* mutate ctx, return ctx */ }

// registration
STEPS.stepName = { fn: stepName, critical: true | false };
```

| Thrown                 | Runner outcome                                                       |
|------------------------|----------------------------------------------------------------------|
| `TimeoutError`         | `failed++`; if `critical` → halt + failure-report                    |
| `NonZeroExitError`     | `failed++`; if `critical` → halt + failure-report                    |
| `SpawnError`           | `failed++`; always halt (binary missing is unrecoverable)            |
| `UpstreamError`        | `failed++`; if `critical` → halt; otherwise `warned++` and continue  |
| `PreconditionError`    | `failed++`; always halt                                              |
| Any other `Error`      | Re-wrapped as `AppError`; `failed++`; halt if `critical`             |

### 5.9 Server Entry (`src/main.js`)

- Boots Express on `PORT` (default `3000`).
- Validates `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` at startup.
- Mounts [src/api/routes.js](src/api/routes.js).
- Serves the dashboard static assets and webhook endpoints.

---

## 6. Test Suite (`tests/`)

### 6.1 `tests/specs/` — auto-generated Playwright specs

Current inventory (SCRUM-T172 … SCRUM-T188) covers the employee-creation story end-to-end: duplicates, session timeout, concurrent access, navigation, autofill, happy path, mandatory fields, invalid data, boundaries, special characters, cancellation, persistence, maximum records, RBAC, slow network, UI feedback, and keyboard accessibility.

### 6.2 `tests/pages/` — Page Object Model (POM)

| Page | Class | Locators (YAML) |
|---|---|---|
| Login | [LoginPage.js](tests/pages/LoginPage.js) | [LoginPage.yml](tests/pages/LoginPage.yml) — `usernameInput`, `passwordInput`, `loginButton`, `errorAlert` |
| Add Employee | [AddEmployeePage.js](tests/pages/AddEmployeePage.js) | [AddEmployeePage.yml](tests/pages/AddEmployeePage.yml) |
| Employee List | [EmployeeListPage.js](tests/pages/EmployeeListPage.js) | [EmployeeListPage.yml](tests/pages/EmployeeListPage.yml) |

Selectors live in YAML files and are loaded at class construction by [tests/helpers/locatorLoader.js](tests/helpers/locatorLoader.js) — this indirection enables [`proactive-healer.js`](scripts/proactive-healer.js) to auto-repair broken locators without touching JavaScript.

### 6.3 `tests/helpers/`, `tests/fixtures/`, `tests/data/`

| File | Responsibility |
|---|---|
| [tests/helpers/locatorLoader.js](tests/helpers/locatorLoader.js) | `loadLocators(yamlPath)` → `{ key: selector }`. |
| [tests/helpers/screenshot.helper.js](tests/helpers/screenshot.helper.js) | `ScreenshotHelper.step(label, fn)` — per-step capture + failure overlay. |
| [tests/fixtures/base.fixture.js](tests/fixtures/base.fixture.js) | Merged POM + screenshot fixture. Exports `{ test, expect }`. |
| [tests/fixtures/pom.fixture.js](tests/fixtures/pom.fixture.js) | POM-only fixture for narrow test files. |
| [tests/data/testData.js](tests/data/testData.js) | `BASE_URL`, `CREDENTIALS`, `TEST_EMPLOYEE`, `ROUTES` constants. |

### 6.4 `tests/perf/`, `tests/security/`, `tests/healed/`

- [tests/perf/](tests/perf/) — generated k6 scripts by test-type (`load/`, `stress/`, `spike/`, `soak/`, `scalability/`, `breakpoint/`), baselines under `baselines/`, mapping in `perf-testcase-map.json`.
- [tests/security/](tests/security/) — ZAP scan configs, `sec-testcase-map.json`.
- [tests/healed/](tests/healed/) — backups of spec files patched by [`healer.js`](scripts/healer.js) and [`proactive-healer.js`](scripts/proactive-healer.js).

### 6.5 Global lifecycle

- [tests/global-setup.js](tests/global-setup.js) — health-checks the AUT, authenticates once, caches `storageState.json`, ensures output directories exist.
- [tests/global-teardown.js](tests/global-teardown.js) — final summary logging.

---

## 7. Operational Scripts (`scripts/`)

| Script | Role |
|---|---|
| **Full pipelines** | |
| [run-full-pipeline.js](scripts/run-full-pipeline.js) | 8-stage autonomous run (story → execution → heal → bugs → reports → git). `--use-runner` opts into the consolidated `src/pipeline/runner.js`. |
| [qa-run.js](scripts/qa-run.js) | 9-stage functional pipeline, opt-in perf/security. |
| [run-qa-complete.js](scripts/run-qa-complete.js) | 14-stage unified functional + perf + security. |
| [run-e2e.js](scripts/run-e2e.js) | **17-stage** PREPARE / EXECUTE / REPORT supersystem. Includes Stage 10b (pentest execute) and Stage 13b (pentest report). |
| **Dedicated pillar runners** | |
| [run-functional.js](scripts/run-functional.js) | **6-stage** Playwright-only pipeline: execute specs → heal → bugs → HTML report → Allure → git. Flags: `--headless`, `--skip-heal`, `--skip-bugs`, `--skip-sync`, `--skip-report`, `--skip-git`. |
| [run-nonfunctional.js](scripts/run-nonfunctional.js) | **4-stage** non-functional pipeline: Performance → Security → **Penetration Tests** → Git. Flags: `--skip-perf`, `--skip-security`, `--skip-pentest`, `--no-zap`, `--skip-git`. |
| [run-perf.js](scripts/run-perf.js) | 6-stage k6 pipeline: generate → execute → evaluate → sync → report → git. |
| [run-perf-only.js](scripts/run-perf-only.js) | Thin banner wrapper — forwards all args to `run-perf.js`. Entry point for `npm run perf:only`. |
| [run-security.js](scripts/run-security.js) | **8-stage** ZAP pipeline. Stage 7 = Penetration Test (calls `run-pentest.js --skip-git --no-pause`). Accepts `--skip-pentest`. |
| [run-security-only.js](scripts/run-security-only.js) | Banner wrapper — delegates entirely to `run-security.js`. Forwards all args including `--skip-pentest`. |
| [run-pentest.js](scripts/run-pentest.js) | **10-stage** automated penetration testing pipeline (see Section 12). Requires `PENTEST_ENABLED=true`. |
| [run-story-tests.js](scripts/run-story-tests.js) | 7-stage per-story Playwright run. |
| [run-tagged-tests.js](scripts/run-tagged-tests.js) | Tag-aliased Playwright run. |
| [run-tag.js](scripts/run-tag.js) | Streamlined tag runner with built-in aliases, `--list-only` preview, and optional heal/report/git. Flags: `--tag`, `--headless`, `--skip-heal`, `--skip-bugs`, `--skip-report`, `--skip-git`, `--list-only`. Tag aliases: `smoke`, `regression`, `bva`, `ep`, `negative`, `boundary`, `security`, `rbac`, `unicode`, `ui`, `cancel`, `persistence`, `duplicate`, `max`, or any Zephyr key / regex. |
| [run-story.js](scripts/run-story.js) | Fetches a single Jira story and creates detailed test cases in Zephyr. Uses full agent pipeline (Planner → QA → Reviewer → Risk Prioritizer). Accepts `ISSUE_KEY` from env or CLI arg. |
| [run-and-sync.js](scripts/run-and-sync.js) | Lightweight execute-and-sync helper. |
| **Generators** | |
| [generate-playwright.js](scripts/generate-playwright.js) | Zephyr → Playwright spec scaffolding. Exits with code `2` when zero specs are written. |
| [generate-perf-scripts.js](scripts/generate-perf-scripts.js) | Story → k6 scripts via `performance.agent`. |
| [generate-sec-scripts.js](scripts/generate-sec-scripts.js) | Story → ZAP config via `security.agent`. |
| **Reports** | |
| [generate-report.js](scripts/generate-report.js) | Custom functional HTML (pie chart, per-test cards, embedded media). |
| [generate-perf-report.js](scripts/generate-perf-report.js) | Chart.js-powered perf HTML. Scans `test-results/perf/*.json` excluding `*-summary.json` and `*-thresholds.json`. |
| [generate-sec-report.js](scripts/generate-sec-report.js) | OWASP-mapped ZAP HTML. |
| [generate-pentest-report.js](scripts/generate-pentest-report.js) | Self-contained HTML pentest report with Chart.js CVSS bars, OWASP category grouping, severity colour-coding. Output: `custom-report/pentest/index.html`. Also callable standalone via `npm run pentest:report`. |
| [generate-allure-report.js](scripts/generate-allure-report.js) | Allure HTML via `allure-commandline`. |
| **Integrations** | |
| [create-jira-bugs.js](scripts/create-jira-bugs.js) | One Jira bug per failing test, linked to parent story. |
| [git-sync.js](scripts/git-sync.js) | Auto-stage + auto-commit + safe push. |
| **Healing** | |
| [healer.js](scripts/healer.js) | **Reactive** patch agent (post-run). |
| [smart-healer.js](scripts/smart-healer.js) | **Proactive structural** healer (post-diff). |
| [proactive-healer.js](scripts/proactive-healer.js) | **Pre-run locator repair** (browser probe + YAML / Zephyr / spec patching). |
| [analyse-impact.js](scripts/analyse-impact.js) | Stage 1 of proactive healing → `impact-manifest.json`. |
| [classify-changes.js](scripts/classify-changes.js) | Frontend / backend / config classification of git diff. |
| [visual-diff.js](scripts/visual-diff.js) | Pixelmatch visual regression. |
| [dom-inspector.js](scripts/dom-inspector.js) | DOM structural diff. |
| [api-schema-diff.js](scripts/api-schema-diff.js) | API response schema diff. |
| [resolve-affected-pages.js](scripts/resolve-affected-pages.js) | Legacy page-mapper (git diff → pages). |
| **Diagnostics** | |
| [pre-flight.js](scripts/pre-flight.js) | Parallel health checks (< 10 s, `Promise.allSettled`): `ISSUE_KEY` present, dirs created if missing, Jira auth OK, Zephyr auth OK, `k6` on PATH (critical when `--include-perf`), ZAP available (critical when `--include-security`). Exit 1 on any critical failure. |
| [ensure-dirs.js](scripts/ensure-dirs.js) | Guarantees all output directories exist. |
| [cleanup-artifacts.js](scripts/cleanup-artifacts.js) | **Artifact retention sweeper.** Deletes old files. Supports `--dry-run` and `--aggressive`. Writes rolling summary to `logs/cleanup-report.json`. |
| [test-agents.js](scripts/test-agents.js) | Offline agent smoke test. |
| [test-endpoints.js](scripts/test-endpoints.js) | HTTP smoke test against `localhost:3000`. |
| [validate-integration.js](scripts/validate-integration.js) | Live Jira + Zephyr connectivity probe. |
| [diag-zephyr.js](scripts/diag-zephyr.js) | Zephyr sync troubleshooter. |

---

## 8. Pipelines & Runners

### 8.1 `run-full-pipeline.js` — 8 stages (legacy) · `--use-runner` (consolidated)

**Default (legacy) path — 8 stages:**

1. Jira story fetch + agent pipeline (Planner → QA → Reviewer → Risk → Executor).
2. Playwright spec generation.
3. Playwright execution → Zephyr cycle sync.
4. Reactive healing ([`healer.js`](scripts/healer.js)).
5. Auto Jira bug creation.
6. Custom HTML report.
7. Allure HTML report.
8. Git sync (auto-commit + push).

**Flags:** `--include-perf`, `--include-security`, `--headless`, `--force`, `--skip-heal`, `--skip-smart-heal`, `--skip-bugs`, `--skip-git`.

**Consolidated path — `--use-runner` (recommended):**

Delegates to [`src/pipeline/runner.js`](src/pipeline/runner.js) with a preset from [`src/pipeline/presets.js`](src/pipeline/presets.js) (`PIPELINE_PRESET` env, default `full`). Adds pre-flight, classified errors, critical-step halt, and proper non-zero exit codes.

### 8.2 `run-functional.js` — 6 stages (functional pillar)

Dedicated Playwright-only runner: **execute specs → sync Zephyr → reactive heal → Jira bugs → HTML report → Allure → git**. No performance or security work. Flags: `--headless`, `--skip-heal`, `--skip-bugs`, `--skip-sync`, `--skip-report`, `--skip-git`.

### 8.3 `run-nonfunctional.js` — 4 stages (non-functional pillar)

```
Stage 1  Performance tests  <- run-perf.js --skip-git
Stage 2  Security tests     <- run-security.js --skip-git --skip-pentest
Stage 3  Penetration Tests  <- run-pentest.js --skip-git --no-pause
Stage 4  Git sync           <- git-sync.js
```

- Security (Stage 2) always receives `--skip-pentest` to prevent double-run.
- `PENTEST_ENABLED=true` must be set in `.env` for Stage 3 to execute.
- Guards: if all of `--skip-perf && --skip-security && --skip-pentest` are passed, the script exits early.

### 8.4 `run-security.js` — 8 stages (security + pentest pillar)

```
Stage 1  Generate security scan config   <- generate-sec-scripts.js
Stage 2  Start OWASP ZAP                 <- auto-launch or Docker
Stage 3  Run ZAP scans + 18 custom checks
Stage 4  Evaluate findings
Stage 5  Sync Zephyr / Jira
Stage 6  Generate security HTML report
Stage 7  Penetration Test (Nuclei + SQLMap + ffuf + ZAP-Auth)
         <- run-pentest.js --skip-git --no-pause
         (skipped if --skip-pentest or PENTEST_ENABLED != 'true')
Stage 8  Git sync
```

Flags: `--skip-generate`, `--no-zap`, `--skip-sync`, `--skip-bugs`, `--skip-report`, `--skip-pentest`, `--skip-git`.

### 8.5 `run-pentest.js` — 10 stages (pentest pillar)

See Section 12 for the full stage breakdown.

### 8.6 `run-e2e.js` — 17 stages (PREPARE / EXECUTE / REPORT)

```
Phase A - PREPARE
  Stage 1   Ensure output directories
  Stage 2   Analyse Jira story -> test plan -> Zephyr TCs
  Stage 3   Generate Playwright specs
  Stage 4   Generate k6 performance scripts
  Stage 5   Generate ZAP security scan config

Phase B - EXECUTE
  Stage 6   Run Playwright tests -> sync Zephyr / Jira
  Stage 7   Self-Healing Agent -> repair + re-run
  Stage 8   Auto-create Jira bugs
  Stage 9   Run k6 performance tests -> evaluate SLAs -> sync
  Stage 10  Run security scans (ZAP + custom) -> evaluate  [passes --skip-pentest]
  Stage 10b Run penetration tests (Nuclei + SQLMap + ffuf)  [skip if --skip-pentest]

Phase C - REPORT
  Stage 11  Generate functional HTML report
  Stage 12  Generate performance HTML report
  Stage 13  Generate security HTML report
  Stage 13b Generate pentest HTML report                    [skip if --skip-pentest]
  Stage 14  Generate Allure interactive report
  Stage 15  Git sync
```

Security (Stage 10) always receives `--skip-pentest` so pentest runs once via Stage 10b only.

Flags: `--headless`, `--skip-pentest`, `--skip-perf`, `--skip-security`, `--no-zap`, `--skip-story`, `--skip-heal`, `--skip-smart-heal`, `--skip-bugs`, `--skip-git`, `--force`.

### 8.7 `qa-run.js` — 9 stages (functional-only default)

Fetches Jira → creates Zephyr TCs → runs Playwright → heals → bugs → reports. Flags: `--run-only`, `--skip-story`, `--include-perf`, `--include-security`.

### 8.8 `run-qa-complete.js` — 14 stages (tri-pillar)

Orchestrates functional (Playwright) + perf (k6) + security (OWASP ZAP). Flags: `--headless`, `--skip-functional`, `--skip-perf`, `--skip-security`, `--no-zap`, `--skip-bugs`, `--skip-git`.

### 8.9 Story- and tag-scoped runs

- [run-story-tests.js](scripts/run-story-tests.js) — resolves Zephyr test cases for an `ISSUE_KEY`, runs only those, then heals + reports + syncs.
- [run-tagged-tests.js](scripts/run-tagged-tests.js) — two-level filter (filename + Playwright `--grep`) with tag aliases.
- [run-tag.js](scripts/run-tag.js) — streamlined replacement with `--list-only` and built-in aliases.

---

## 9. Self-Healing Subsystem

The platform ships **three healers** operating at different points in the lifecycle:

| Dimension | `healer.js` | `smart-healer.js` | `proactive-healer.js` |
|---|---|---|---|
| **Trigger** | After test failures | After `git diff` | Before Playwright run |
| **Input** | `test-results.json` | git diff | `impact-manifest.json` |
| **Scope** | Specs only (timeouts, strict mode, visibility, selectors) | POM YAML + specs + Zephyr | POM YAML + specs + Zephyr via live browser probe |
| **Browser** | No | No | **Yes** — headless Chromium probe |
| **Output** | `test-results-healed.json` | `change-manifest.json` + `smart-healing-report.json` | Healed YAML, Zephyr PUTs, patched specs, optional re-run |
| **Manual review** | Not applicable | Exit 1 signals required review | `manual-review-needed` status per locator |

### 9.1 Proactive Healer workflow

```
git diff HEAD~1 HEAD
      |
      v
analyse-impact.js  -->  impact-manifest.json
      |
      v
proactive-healer.js
      |
  +---+---+-------------------+
  v       v                   v
(A) POM heal  (B) Zephyr update  (C) Spec patch
  probe         PUT /testcases    string-replace
  repair        [auto-healed]     backup + atomic rename
      |
      v
Optional: npx playwright test --grep "<keys>"
```

Flags: `--dry-run`, `--skip-pom`, `--skip-zephyr`, `--skip-specs`, `--skip-run`.

### 9.2 Visual / API diff detection

- [`visual-diff.js`](scripts/visual-diff.js) — full-page screenshots, pixelmatch against baselines in `heal-artifacts/baselines/`.
- [`api-schema-diff.js`](scripts/api-schema-diff.js) — Playwright network interception, schema diff against `heal-artifacts/api-baselines/`.
- [`dom-inspector.js`](scripts/dom-inspector.js) — DOM structural comparison.

---

## 10. Performance Testing Subsystem

### 10.1 Six test types

| Type | Intent | SLA env prefix |
|---|---|---|
| `load` | Expected concurrent load | `PERF_LOAD_*` |
| `stress` | Beyond-peak throughput | `PERF_STRESS_*` |
| `spike` | Sudden traffic surge | `PERF_SPIKE_*` |
| `soak` | Endurance (hours) | `PERF_SOAK_*` |
| `scalability` | Step-wise growth | `PERF_SCALE_*` |
| `breakpoint` | Ramp until failure | `PERF_BREAK_*` |

### 10.2 Script generation

[`performance.agent.js`](src/agents/performance.agent.js) analyses the story for signals and emits stages / thresholds / VU profiles. [`perfScript.generator.js`](src/tools/perfScript.generator.js) converts that into k6 scripts using **valid k6 threshold syntax**:

```js
thresholds: {
  'login_duration':    ['p(50)<1080', 'p(90)<2400', 'p(95)<3000'],
  'navigate_duration': ['p(50)<900',  'p(90)<1800', 'p(95)<2250'],
  'action_duration':   ['p(50)<700',  'p(90)<1400', 'p(95)<1750'],
}
```

### 10.3 Execution

[`run-perf.js`](scripts/run-perf.js) stages: **generate → execute → evaluate SLAs → sync Zephyr/Jira → report → git sync**. Binary path overridable via `PERF_K6_BINARY`. Flags: `--test-type`, `--dry-run`, `--skip-generate`, `--skip-sync`, `--skip-git`.

### 10.4 Reporting

[`generate-perf-report.js`](scripts/generate-perf-report.js) renders per-test-type dashboards with Chart.js, SLA breach markers, and baseline deltas.

**Visualisations (8 tabs):** Response Time, Latency Distribution, Throughput Timeline, Network Breakdown, All Scripts Table, Script Details, Baseline Comparison, VU vs Latency Timeline.

**Time-bucketed series.** `buildTimeSeries(ndjsonPath, bucketSec=5)` streams the k6 NDJSON, buckets by timestamp, and computes per-bucket `p50`/`p95`/`p99`/`rps`/`errorRate`/`vus`.

**Automated Insights.** `buildInsights(rows, thresholds)` auto-generates observations: near-SLA warnings (p99 >= 90% of threshold), error-rate breaches, baseline regressions, high TTFB detection.

---

## 11. Security Testing Subsystem

### 11.1 Scan generation

[`security.agent.js`](src/agents/security.agent.js) detects security signals and maps them to **OWASP Top 10 2021**. [`secScript.generator.js`](src/tools/secScript.generator.js) emits scan configs.

### 11.2 Execution — 8 stages

[`run-security.js`](scripts/run-security.js) — 8 stages:

1. Generate ZAP scan config (`security.agent` + `secScript.generator`)
2. Start OWASP ZAP (docker or local auto-launch; `ZAP_AUTO_LAUNCH=true` pre-spawns ZAP during Stage 1)
3. Run ZAP passive/active scan + **18 custom checks** (SQLi, XSS, auth-bypass, security headers, CSRF, cookie flags, CORS, IDOR, open redirect, path traversal, etc.)
4. Evaluate findings — `ZAP_FAIL_ON` (default `high`) and `ZAP_WARN_ON` (default `medium`) severity policy
5. Sync results to Zephyr / create Jira bugs
6. Generate security HTML report (`custom-report/security/index.html`)
7. **Penetration Test** — calls `run-pentest.js --skip-git --no-pause` (skipped if `--skip-pentest` passed or `PENTEST_ENABLED !== 'true'`)
8. Git sync

`--no-zap` flag skips Stages 2–3 and runs custom checks only.

### 11.3 Reporting

[`generate-sec-report.js`](scripts/generate-sec-report.js) colours findings by severity and groups by OWASP category. Aggregated via `GET /security/summary`.

---

## 12. Penetration Testing Subsystem

The penetration testing pillar is a **10-stage autonomous pipeline** built on real security tooling. It is always **opt-in** — requires `PENTEST_ENABLED=true` in `.env` and must target only hosts explicitly listed in `PENTEST_ALLOWED_HOSTS`.

### 12.1 Agent — `pentest.agent.js`

See [Section 5.1.3](#513-pentest-agent--pentestagentjs) for the full signal map, tag map, and output schema.

### 12.2 Tool binaries

| Tool | Version | Install path | Purpose |
|---|---|---|---|
| **Nuclei** | v3.8.0 | `C:\POC\tools\nuclei\nuclei.exe` | CVE / template-based vulnerability scanning |
| **SQLMap** | — | `sqlmap` (Python, optional) | SQL injection detection |
| **ffuf** | v2.1.0 | `C:\POC\tools\ffuf\ffuf.exe` | Endpoint / directory fuzzing |
| **SecLists** | latest | `C:\POC\SecLists\` | Wordlists: `common.txt`, `dirsearch.txt`, `api/api-endpoints.txt` |
| **OWASP ZAP** | existing | `ZAP_PATH` / `ZAP_API_URL` | Authenticated scan (Stage 5) |

Stages 2–5 **soft-fail** on `ENOENT` — a missing binary logs a warning and the pipeline continues. This allows running with a subset of tools (e.g. ffuf-only with `--test-tool=ffuf`).

### 12.3 Pipeline — 10 stages

```
Stage 0  Scope Guard (hard-fail)
         +- PENTEST_ENABLED must be 'true'
         +- enforceScope(targetUrl): target hostname must be in PENTEST_ALLOWED_HOSTS
         +- 5-second countdown (skipped with --no-pause / --headless)

Stage 1  Story Analysis / Plan Generation (hard-fail)
         +- Tries to load real Jira story via jira.client.getStory(storyKey)
         +- Falls back to PENTEST_STORY_SUMMARY / PENTEST_STORY_DESCRIPTION stubs
         +- pentest.agent.plan(story) -> pentestPlan
         +- Saves plan to logs/pentest/<ISSUE_KEY>-pentest-plan.json

Stage 2  Nuclei CVE / Template Scan (soft-fail)
         +- Spawns NUCLEI_BINARY with -tags <nucleiTags> -severity <severities>
         +- Parses JSONL output -> findings[]
         +- Soft-fails on ENOENT (nuclei not installed)

Stage 3  SQLMap Injection Scan (soft-fail)
         +- Spawns SQLMAP_BINARY against endpointPaths with common payloads
         +- Parses stdout for injection-confirmed markers
         +- Soft-fails on ENOENT

Stage 4  ffuf Endpoint Fuzzing (soft-fail)
         +- Spawns FFUF_BINARY with wordlist from SECLIST_PATH/Discovery/Web-Content/
         +- -mc 200,301,302,403 -o <outfile> -of json
         +- Parses results -> findings[]
         +- Soft-fails on ENOENT; first live run found 91 findings (86 low, 5 info)

Stage 5  ZAP Authenticated Scan (soft-fail)
         +- Logs in via AUT_USERNAME / AUT_PASSWORD
         +- Runs spider + active scan on endpointPaths
         +- Normalises ZAP alerts to unified findings schema

Stage 6  Unify Findings
         +- Merges Nuclei + SQLMap + ffuf + ZAP-Auth findings
         +- Deduplicates by (url + title) hash
         +- summary = { critical, high, medium, low, info, total, duplicates }

Stage 7  Evaluate Severity Policy
         +- PENTEST_FAIL_ON  (default 'critical')  -> verdict = 'fail'
         +- PENTEST_WARN_ON  (default 'high')       -> verdict = 'warn'
         +- Otherwise                               -> verdict = 'pass'

Stage 8  Jira Bug Creation (soft-fail)
         +- One Jira bug per finding where severity >= PENTEST_FAIL_ON

Stage 9  Zephyr Sync (soft-fail)
         +- Updates mapped test-case execution status based on verdict

Stage 10 Generate Report + Git push (soft-fail)
         +- generate-pentest-report.js -> custom-report/pentest/index.html
         +- git-sync.js (unless --skip-git)
```

### 12.4 CLI flags

| Flag | Effect |
|---|---|
| `--no-pause` | Skip the 5-second countdown in Stage 0 |
| `--headless` | Implies `--no-pause` |
| `--dry-run` | Print commands only; no tools are spawned |
| `--skip-plan` | Reuse existing plan from disk (if present) |
| `--skip-nuclei` | Skip Stage 2 |
| `--skip-sqlmap` | Skip Stage 3 |
| `--skip-ffuf` | Skip Stage 4 |
| `--no-zap-auth` | Skip Stage 5 |
| `--skip-bugs` | Skip Stage 8 |
| `--skip-sync` | Skip Stage 9 |
| `--skip-report` | Skip report generation in Stage 10 |
| `--skip-git` | Skip git push in Stage 10 |
| `--test-tool=<name>` | Run only one tool (`nuclei`, `sqlmap`, `ffuf`, `zap-auth`) |

### 12.5 Findings schema

```js
{
  id:          string,     // hash of url+title
  tool:        string,     // 'nuclei' | 'sqlmap' | 'ffuf' | 'zap-auth'
  title:       string,
  url:         string,
  severity:    string,     // 'critical' | 'high' | 'medium' | 'low' | 'info'
  cvss:        number,     // 0-10
  owaspId:     string,     // e.g. 'A03:2021'
  description: string,
  evidence:    string,     // raw tool output excerpt
  remediation: string,
}
```

### 12.6 Pentest report — `generate-pentest-report.js`

Self-contained single-file HTML (`custom-report/pentest/index.html`):

- **Verdict banner** — PASS / WARN / FAIL with colour coding.
- **Summary card grid** — total findings, per-severity counts, tool coverage.
- **CVSS bar chart** — per-finding CVSS score visualisation (Chart.js, bundled inline).
- **OWASP category breakdown** — findings grouped by OWASP Top 10 2021 ID.
- **Finding cards** — severity badge, CVSS bar, tool label, URL, description, evidence, remediation.

The function signature:

```js
generatePentestReport(findings, plan, verdict, outputDir, meta)
// meta = { storyKey, bugKeys }
// returns Promise<string>  (path to written HTML)
```

### 12.7 Integration with parent pipelines

| Parent pipeline | How pentest is called | Double-run prevention |
|---|---|---|
| `run-security.js` (Stage 7) | `run-pentest.js --skip-git --no-pause` | N/A — pentest is Stage 7 of security |
| `run-nonfunctional.js` (Stage 3) | `run-pentest.js --skip-git --no-pause` | Security (Stage 2) receives `--skip-pentest` |
| `run-e2e.js` (Stage 10b) | `run-pentest.js --skip-report --skip-git --skip-sync --no-pause` | Stage 10 (security) receives `--skip-pentest` |
| `run-e2e.js` (Stage 13b) | `generate-pentest-report.js` | Separate report-only call |

All invocations guard on `PENTEST_ENABLED=true` and soft-fail.

---

## 13. Reporting & Dashboard

| Output | Location | Generator |
|---|---|---|
| Custom functional HTML | [custom-report/index.html](custom-report/index.html) | [generate-report.js](scripts/generate-report.js) |
| Applitools visual HTML | [custom-report/applitools-report.html](custom-report/applitools-report.html) | Applitools Eyes SDK (optional) |
| Performance HTML | `custom-report/perf/index.html` | [generate-perf-report.js](scripts/generate-perf-report.js) |
| Security HTML | `custom-report/security/index.html` | [generate-sec-report.js](scripts/generate-sec-report.js) |
| **Pentest HTML** | `custom-report/pentest/index.html` | [generate-pentest-report.js](scripts/generate-pentest-report.js) |
| Allure HTML | [allure-report/index.html](allure-report/index.html) | [generate-allure-report.js](scripts/generate-allure-report.js) |
| Playwright HTML | [playwright-report/](playwright-report/) | Playwright built-in |
| Logs | [logs/app.log](logs/), [logs/error.log](logs/) | Winston |
| Healing artefacts | [heal-artifacts/](heal-artifacts/) | visual/dom/api-diff + smart-healer |
| React dashboard | [dashboard/](dashboard/) | Standalone npm package |

---

## 14. CI/CD — GitHub Actions

| Workflow | Trigger | Jobs |
|---|---|---|
| [.github/workflows/qa.yml](.github/workflows/qa.yml) | `push` to `main` + manual | `qa` — installs Node 20 + Playwright + k6 + ZAP docker, runs `scripts/pre-flight.js` first, then `scripts/run-full-pipeline.js --use-runner --include-perf --include-security --headless`. Uploads `logs/pipeline-failure-report.json` on failure. |
| [.github/workflows/smart-proactive-heal.yml](.github/workflows/smart-proactive-heal.yml) | `push` (ignoring heal artifacts) | `classify` → `diff` → `heal` → `report`. |
| [.github/workflows/scoped-qa.yml](.github/workflows/scoped-qa.yml) | `pull_request`, `push main`, `workflow_dispatch` | `scoped-execution` — runs `analyse-impact.js`, calls `proactive-healer.js --skip-run` when `affectedTestKeys > 0`, executes story/tag/full scope, posts GITHUB_STEP_SUMMARY + PR comment. |

---

## 15. Configuration Reference

### 15.1 `.env.example` keys (values redacted)

**Credentials:** `OPENAI_API_KEY`, `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `PROJECT_KEY`, `ISSUE_KEY`, `ZEPHYR_BASE_URL`, `ZEPHYR_ACCESS_KEY`, `PORT`.

**Agents:** `AGENT_CONFIDENCE_THRESHOLD` (default `0.4`).

**Pipeline:** `PIPELINE_USE_RUNNER`, `PIPELINE_PRESET`, `PLAYWRIGHT_EXEC_TIMEOUT_MS` (default `300000`).

**Webhooks:** `WEBHOOK_SECRET`, `WEBHOOK_TRIGGER_STATUSES`.

**API auth:** `API_SECRET`.

**Performance:** `PERF_K6_BINARY`, `PERF_LOAD_P95`, `PERF_LOAD_P99`, `PERF_LOAD_ERROR`, `PERF_STRESS_*`, `PERF_SPIKE_*`, `PERF_SOAK_*`, `PERF_SCALE_*`, `PERF_BREAK_*`, `PERF_BASELINE_TOLERANCE_{P95,P99,AVG,ERR}`, `PERF_VUS_MAX`, `PERF_SOAK_DURATION`, `PERF_SKIP_SOAK`.

**Security:** `ZAP_API_URL`, `ZAP_API_KEY`, `ZAP_DOCKER`, `ZAP_SCAN_TYPE`, `ZAP_FAIL_ON`, `ZAP_WARN_ON`, `ZAP_PATH`, `ZAP_AUTO_LAUNCH`, `ZAP_POLL_INTERVAL_MS`.

**Penetration Testing:**

| Variable | Default | Purpose |
|---|---|---|
| `PENTEST_ENABLED` | `false` | Must be `true` to activate any pentest stage |
| `PENTEST_TARGET_URL` | `BASE_URL` | Target URL for all pentest tools |
| `PENTEST_ALLOWED_HOSTS` | — | Comma-separated authorised hostnames (scope guard hard-fails if target not listed) |
| `PENTEST_FAIL_ON` | `critical` | Findings at or above this severity set verdict = `fail` |
| `PENTEST_WARN_ON` | `high` | Findings at or above this severity set verdict = `warn` |
| `NUCLEI_BINARY` | `nuclei` | Absolute path to nuclei executable |
| `SQLMAP_BINARY` | `sqlmap` | sqlmap command (Python required) |
| `FFUF_BINARY` | `ffuf` | Absolute path to ffuf executable |
| `SECLIST_PATH` | — | Root of SecLists wordlists directory |
| `PENTEST_STORY_SUMMARY` | `ISSUE_KEY` | Story summary override when Jira is unreachable |
| `PENTEST_STORY_DESCRIPTION` | — | Story description override when Jira is unreachable |

**AUT:** `BASE_URL`, `AUT_USERNAME`, `AUT_PASSWORD`.

**Visual:** `APPLITOOLS_API_KEY`, `USE_ULTRAFAST_GRID`, `APPLITOOLS_CONCURRENCY`, `APPLITOOLS_BATCH_ID`.

### 15.2 `playwright.config.js` highlights

| Setting | Value |
|---|---|
| `testDir` | `./tests/specs` |
| `timeout` | 90 000 ms |
| `retries` | 1 |
| `workers` | 3 (overridable via `PW_WORKERS`) |
| `fullyParallel` | `true` |
| Reporters | `list`, `json`, `html`, `allure-playwright` |
| `baseURL` | `https://opensource-demo.orangehrmlive.com` |
| `headless` | `PW_HEADLESS` env |
| Media | `screenshot: only-on-failure`, `video/trace: retain-on-failure` |

### 15.3 ESLint rules

`strict: ["warn","global"]`, `no-unused-vars` (ignore `^_`), `eqeqeq: error`, `no-var: error`, `prefer-const: warn`, `no-throw-literal: error`, `no-eval: error`.

---

## 16. External Integrations

| System | Protocol / Client | Usage |
|---|---|---|
| **Jira** | REST v3 (basic auth) | Story fetch, bug creation, issue links |
| **Zephyr Scale** | Essential Cloud API v2.8 (bearer token) | Test case + cycle + execution CRUD |
| **Playwright** | `@playwright/test` | Functional + visual base |
| **k6** | Binary spawn (`PERF_K6_BINARY`) | Performance — load/stress/spike/soak/scalability/breakpoint |
| **OWASP ZAP** | Docker or local API | Security scanning (passive + active) + authenticated pentest scan |
| **Nuclei** | Binary spawn (`NUCLEI_BINARY`) | CVE / template-based vulnerability scanning |
| **SQLMap** | Python spawn (`SQLMAP_BINARY`) | SQL injection detection (optional — soft-fails without Python) |
| **ffuf** | Binary spawn (`FFUF_BINARY`) | Endpoint / directory fuzzing with SecLists wordlists |
| **SecLists** | Filesystem (`SECLIST_PATH`) | Wordlists for ffuf (`common.txt`, `dirsearch.txt`, `api-endpoints.txt`) |
| **Applitools Eyes** | JS SDK (opt-in) | Visual regression |
| **Allure** | `allure-commandline` + `allure-playwright` | Interactive reporting |
| **GitHub Actions** | Workflow YAML | CI/CD |
| **Winston** | npm | Logging |
| **Express** | npm | REST API |

---

## 17. End-to-End Execution Flows

### 17.1 Full e2e run (four pillars)

```bash
npm run e2e
```

Runs all 17 stages: Phase A (Prepare), Phase B (Execute — functional + perf + security + pentest), Phase C (Report — functional + perf + security + pentest + Allure).

### 17.2 Non-functional only (perf + security + pentest)

```bash
npm run nonfunctional
```

```
Stage 1  run-perf.js --skip-git            -> k6 all test types
Stage 2  run-security.js --skip-git        -> ZAP + 18 checks (--skip-pentest passed)
         --skip-pentest
Stage 3  run-pentest.js --skip-git         -> Nuclei + SQLMap + ffuf + ZAP-Auth
         --no-pause
Stage 4  git-sync.js                       -> commit + push all reports
```

### 17.3 Pentest standalone

```bash
npm run pentest            # headed, with 5-second countdown
npm run pentest:headless   # CI / --no-pause
npm run pentest:nuclei     # Nuclei only, no git/sync
npm run pentest:ffuf       # ffuf only, no git/sync
npm run pentest:dry-run    # print commands, no execution
```

### 17.4 Push-driven full run (CI)

```
git push
  |
  v
qa.yml (GitHub Actions)
  |
  +-- scripts/pre-flight.js --include-perf --include-security  <- fail-fast
  +-- scripts/run-full-pipeline.js --use-runner --include-perf
                                    --include-security --headless
        |
        +-- preFlight, ensureDirs, fetchStory, generateSpecs (critical)
        +-- proactiveHeal (non-critical)
        +-- executeFunctional (critical)
        +-- executePerformance, executeSecurity (non-critical)
        +-- reactiveHeal, createBugs, generateReports, syncGit (non-critical)
        |
        v
   On critical halt: logs/pipeline-failure-report.{json,md} uploaded as CI artefact.
```

### 17.5 Pull-request scoped flow

```
pull_request opened
  |
  v
scoped-qa.yml
  +-- analyse-impact.js       -> impact-manifest.json
  +-- (if affected > 0)
  |     +-- proactive-healer.js --skip-run
  +-- Execute scope (story | tag | full)
  +-- Job summary -> GITHUB_STEP_SUMMARY
  +-- PR comment (affected pages, heal counts, pass/fail)
```

### 17.6 Jira-webhook-driven flow

```
Jira status change
  |
  v
POST /webhook/jira (HMAC-SHA256 verified)
  |
  v
webhook.controller.js -> spawn scripts/run-full-pipeline.js $ISSUE_KEY
```

---

## 18. Extending the Platform

| Need | How |
|---|---|
| Add a new page object | Create `tests/pages/NewPage.yml` + `NewPage.js` and extend `PAGE_OBJECT_MAP` in [scripts/analyse-impact.js](scripts/analyse-impact.js) and `PAGE_ROUTES` in [scripts/proactive-healer.js](scripts/proactive-healer.js). |
| Add a new perf test type | Extend the list in [src/agents/performance.agent.js](src/agents/performance.agent.js), mirror SLA envs in `.env.example`, teach [scripts/run-perf.js](scripts/run-perf.js) the new `--test-type` value. |
| Add a new OWASP check | Extend [src/agents/security.agent.js](src/agents/security.agent.js) detection + [src/tools/secScript.generator.js](src/tools/secScript.generator.js) template. |
| Add a new pentest tool | Add signal keywords to `TOOL_SIGNALS` in [src/agents/pentest.agent.js](src/agents/pentest.agent.js), add a stage in [scripts/run-pentest.js](scripts/run-pentest.js) using the soft-fail `spawnSync` pattern, and add env vars to `.env.example`. |
| Add a Nuclei tag category | Add the tag name + keywords to `NUCLEI_TAG_SIGNALS` in [src/agents/pentest.agent.js](src/agents/pentest.agent.js). |
| Plug in an LLM | Wire [src/utils/openai.js](src/utils/openai.js) into `qa.agent` / `planner.agent` behind a feature flag. |
| Add a new report | Drop a generator under `scripts/generate-*-report.js`, output to `custom-report/<name>/index.html`, expose via `src/api/*.controller.js`. |
| Add a new CI trigger | Add a workflow under [.github/workflows/](.github/workflows/) and re-use the existing runner scripts. |
| Add a new pipeline step | Implement `async function myStep(ctx)` in [src/pipeline/steps.js](src/pipeline/steps.js), register it with `{ fn, critical }`, then add its name to the desired preset in [src/pipeline/presets.js](src/pipeline/presets.js). |
| Add a new agent schema | Add `validate*` / `sanitize*` functions and a JSDoc `@typedef` to [src/core/schemas.js](src/core/schemas.js), add >=3 valid and >=3 invalid fixtures to [tests/unit/schemas.test.js](tests/unit/schemas.test.js), run `npm run test:unit`. |

---

## 19. Observability & Schema Contracts

### 19.1 Agent Decision Log

Every agent call appends one JSON entry to `logs/agent-decisions.json` via [`agentDecisionLog.js`](src/agents/agentDecisionLog.js):

```json
{
  "timestamp":  "2026-04-22T10:15:03.241Z",
  "agentName":  "planner",
  "input":      { "storyKey": "SCRUM-6", "title": "Add employee", "wordCount": 48 },
  "output":     { "testTypes": ["Happy Path", "Negative"], "overallConfidence": 0.82 },
  "reasoning":  { "matchedKeywords": [], "scoredCategories": [], "confidenceThreshold": 0.4 }
}
```

Properties: **append-only**, **capped at 2000 entries** (oldest pruned), **never throws**. Newest-first on read.

### 19.2 API — `GET /agent-decisions`

Authed endpoint ([src/api/agentDecisions.controller.js](src/api/agentDecisions.controller.js)):

| Query param | Type    | Default | Range    | Description                       |
|-------------|---------|---------|----------|-----------------------------------|
| `limit`     | integer | 50      | 1–200    | Max entries returned              |
| `agentName` | string  | —       | any      | Filter by agent (`planner`, …)    |

Responses: `200 { total, entries[] }` · `400` on invalid params.

### 19.3 Custom HTML Report — Agent Decisions section

[`generate-report.js`](scripts/generate-report.js) appends a **collapsed `<details>` block per agent** showing the last 20 decisions. Gracefully skipped when the log file is absent.

### 19.4 Schema Validators

[src/core/schemas.js](src/core/schemas.js) exports `validate*` / `sanitize*` pairs for all five agent outputs plus `QATestCase`.

Behaviour at agent boundaries:

1. Agent builds output.
2. `validate*(output)` runs.
3. On failure → `logger.warn('schema validation failed — sanitising')` and `sanitize*()` fills defaults.
4. Validated/sanitised output is returned **and** passed to `logDecision`.

This is enforced by **37 unit tests** under [tests/unit/schemas.test.js](tests/unit/schemas.test.js). Run with: `npm run test:unit`.

### 19.5 Schema shapes (canonical)

```ts
// PlannerOutput
{
  scope: string,
  testTypes: string[],                  // subset of the 10 categories
  designTechniques: ('BVA'|'EP'|'DT'|'ST'|'EG'|'UC')[],
  criticalScenarios: string[],
  risks: string[],
  confidence: number                    // 0..1
}

// pentestPlan (from pentest.agent.plan)
{
  storyKey: string,
  targetUrl: string,
  allowedHosts: string[],
  toolsRequired: string[],
  nucleiTags: string[],
  nucleiSeverities: string[],
  endpointPaths: string[],
  owaspCategories: string[],
  riskLevel: 'low' | 'medium' | 'high' | 'critical',
  estimatedDurationMins: number
}
```

---

## 20. Error Taxonomy & Recovery Hints

All programmatic errors extend `AppError` from [src/core/errorHandler.js](src/core/errorHandler.js). The runner classifies every step failure and surfaces the `recoveryHint`.

| Class              | `code`                 | `status` | Typical trigger                                            | Recovery hint (default)                                                           |
|--------------------|------------------------|----------|------------------------------------------------------------|-----------------------------------------------------------------------------------|
| `AppError`         | `APP_ERROR`            | 500      | Base class — generic failure                               | —                                                                                 |
| `TimeoutError`     | `TIMEOUT`              | 504      | Playwright / step exceeded wall-clock limit                | Increase timeout via env var or reduce workload scope.                            |
| `NonZeroExitError` | `NON_ZERO_EXIT`        | 500      | Child process returned non-zero                            | Inspect stdout/stderr for the actual failure and re-run.                          |
| `SpawnError`       | `SPAWN_FAILED`         | 500      | Binary missing / EACCES / ENOENT                           | Verify the binary is installed and on PATH.                                       |
| `UpstreamError`    | `UPSTREAM_UNAVAILABLE` | 502      | Jira, Zephyr, ZAP not reachable                            | Verify credentials and connectivity to the upstream service.                      |
| `PreconditionError`| `PRECONDITION_FAILED`  | 412      | Zero specs generated, missing handoff file                 | Run the prior stage or ensure required inputs exist.                              |
| `NonZeroExitError` | `BUFFER_OVERFLOW`      | 500      | Playwright stdout exceeded `PLAYWRIGHT_MAX_BUFFER_MB`      | Raise `PLAYWRIGHT_MAX_BUFFER_MB` or set `PLAYWRIGHT_STREAM_OUTPUT=true`.           |

**Zero-spec guard.** [`scripts/generate-playwright.js`](scripts/generate-playwright.js) exits with **code `2`** when it writes no specs. The `generateSpecs` step converts that into a `PreconditionError`.

**Pre-flight short-circuit.** Critical failures (Jira auth, Zephyr auth, missing `ISSUE_KEY`, missing tools) exit 1 before any expensive work starts.

**Pentest scope guard.** Stage 0 calls `pentest.agent.enforceScope(targetUrl)` which hard-fails if the hostname is not in `PENTEST_ALLOWED_HOSTS`. Cannot be bypassed.

### 20.1 Pre-flight check matrix

| # | Check                  | Critical when                          |
|---|------------------------|----------------------------------------|
| 1 | `ISSUE_KEY` present    | Always                                 |
| 2 | Output dirs ready      | Always                                 |
| 3 | Jira auth              | Always                                 |
| 4 | Zephyr auth            | Always                                 |
| 5 | `k6` on PATH           | `--include-perf`                       |
| 6 | ZAP reachable          | `--include-security` (not `--no-zap`)  |

All six run in parallel via `Promise.allSettled`; exits `0` on all critical checks passed, `1` on any failure. Details logged to `logs/preflight-report.json`.

### 20.2 Failure report artefact (CI)

When a critical step fails, the runner writes:

- `logs/pipeline-failure-report.json` — machine-readable full runner result
- `logs/pipeline-failure-report.md` — human-readable markdown rendered into GitHub Actions Step Summary

---

## 21. Operational Runbook

### 21.1 Artifact retention

- **Policy:** files older than `ARTIFACT_RETENTION_DAYS` (default **30**) are deleted by [`scripts/cleanup-artifacts.js`](scripts/cleanup-artifacts.js).
- **Scheduling:** `artifact-cleanup` GH Actions job runs nightly (`cron: '0 2 * * *'`).
- **Local usage:** `npm run cleanup:dry-run` → `npm run cleanup:artifacts` → `npm run cleanup:artifacts:aggressive`.
- **Safety:** `.gitkeep` files and the entire `logs/` tree are never touched. Every run appends to `logs/cleanup-report.json` (rolling last 100 entries).

### 21.2 Scaling considerations

- **Single-pipeline-per-host.** Concurrency enforced by `logs/.pipeline.lock`. Horizontal scaling requires externalising the lock to Redis or a queue.
- **Webhook hardening.** `/api/webhook/jira` is HMAC-signed and rate-limited (default 100/min). Rate-limit state is in-memory; horizontal scale requires a shared store.
- **Playwright memory.** Default 50 MB stdout buffer (`PLAYWRIGHT_MAX_BUFFER_MB`). Set `PLAYWRIGHT_STREAM_OUTPUT=true` for long soak suites.
- **Pentest scope management.** Maintain one `PENTEST_ALLOWED_HOSTS` list per environment. Pentest tools (Nuclei, ffuf) may generate high request volume — schedule runs outside production peak hours.
- **Secrets at scale.** Switch `SECRETS_PROVIDER` from `env` to `vault` to pull credentials from HashiCorp Vault; `logs/secret-access.log` records every key access (key + provider + resolvedLength, never the value).

### 21.3 Secret rotation

1. Update the secret in your provider.
2. Restart the API server (`npm run start:server`) — `initConfig()` re-reads secrets on boot.
3. In-flight pipelines finish with the previous secret; new triggers use the rotated value.
4. Verify `logs/secret-access.log` shows a post-restart entry with the new `resolvedLength`.

### 21.4 Monitoring checklist

| Signal                                                             | Where              | Action                                                                  |
|--------------------------------------------------------------------|--------------------|-------------------------------------------------------------------------|
| `auth-failure` log lines in `logs/app.log`                         | Winston            | Check client configs / possible credential leak; rotate `API_SECRET`.   |
| `rate-limited` log lines                                           | Winston            | Raise `RATE_LIMIT_MAX` or investigate caller.                           |
| `Pipeline already running` 409 from `/webhook/manual`              | HTTP response      | Inspect `logs/.pipeline.lock` for incumbent pid.                        |
| `BUFFER_OVERFLOW` in `logs/pipeline-failure-report.*`              | Failure report     | Raise `PLAYWRIGHT_MAX_BUFFER_MB` or enable streaming mode.              |
| `logs/secret-access.log` growing unexpectedly                      | Filesystem         | Audit for unintended callers of `getSecret()`.                          |
| `logs/cleanup-report.json` with `removedFiles: 0` for > 7 days    | Filesystem         | Verify the nightly GH Actions `artifact-cleanup` job is running.        |
| Pentest verdict = `fail` in `custom-report/pentest/index.html`     | Pentest report     | Triage `critical` findings immediately; remediate before next release.  |
| Nuclei exit code 2 with 0 findings and < 5 s runtime              | Console / logs     | Nuclei templates not downloaded — run `nuclei -update-templates`.       |

---

_© Agentic QA Platform — rule-based agents, pluggable pillars, self-healing by design._
