# Agentic QA Platform — Detailed Solution Documentation

> **End-to-end, AI-agent-driven QA automation for Jira + Zephyr Scale + Playwright + k6 + OWASP ZAP, with reactive and proactive self-healing.**
>
> _Generated: April 2026 · Node ≥ 18 · CommonJS · Target AUT: OrangeHRM open-source demo_

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
12. [Reporting & Dashboard](#12-reporting--dashboard)
13. [CI/CD — GitHub Actions](#13-cicd--github-actions)
14. [Configuration Reference](#14-configuration-reference)
15. [External Integrations](#15-external-integrations)
16. [End-to-End Execution Flows](#16-end-to-end-execution-flows)
17. [Extending the Platform](#17-extending-the-platform)
18. [Observability & Schema Contracts](#18-observability--schema-contracts)
19. [Error Taxonomy & Recovery Hints](#19-error-taxonomy--recovery-hints)

---

## 1. Executive Summary

The **Agentic QA Platform** is an enterprise-grade automation pipeline that turns a single Jira user story into a fully executed, triaged, self-healed, and reported quality assurance run across **three testing pillars**:

| Pillar | Tooling | Agent |
|---|---|---|
| **Functional** | Playwright + Page Object Model | `planner` → `qa` → `reviewer` → `riskPrioritizer` → `executor` |
| **Performance** | k6 (`load`, `stress`, `spike`, `soak`, `scalability`, `breakpoint`) | `performance.agent` + `perfScript.generator` |
| **Security** | OWASP ZAP (docker / API) + custom checks | `security.agent` + `secScript.generator` |

**Key properties**

- **Rule-based agents** (no external LLM required) — keyword analysis, design-technique heuristics, and Levenshtein similarity drive test design.
- **Full traceability** — Jira story → Zephyr test cases → Playwright specs → execution results → Zephyr cycle → Jira bug tickets → git commit → PR comment.
- **Three-tier healing** — reactive ([`healer.js`](scripts/healer.js)), proactive structural ([`smart-healer.js`](scripts/smart-healer.js)), and pre-run locator repair ([`proactive-healer.js`](scripts/proactive-healer.js)).
- **Enterprise reports** — custom HTML ([custom-report/](custom-report/)), Allure ([allure-report/](allure-report/)), Playwright native ([playwright-report/](playwright-report/)), plus performance and security dashboards.
- **CI/CD** — three GitHub Actions workflows cover push, PR, and manual triggers.

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                       JIRA   (story trigger)                         │
│                         │                                            │
│                         ▼                                            │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │   AGENT PIPELINE (src/orchestrator/agentOrchestrator.js)      │   │
│  │                                                               │   │
│  │  Jira → Planner → QA → Reviewer → RiskPrioritizer → Executor  │   │
│  │                                                          │    │   │
│  │                                                          ▼    │   │
│  │                                                      ZEPHYR    │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                         │                                            │
│                         ▼                                            │
│     ┌──────────────┬──────────────────┬──────────────┐               │
│     ▼              ▼                  ▼              ▼               │
│ PLAYWRIGHT      k6 (perf)          OWASP ZAP      HEALING            │
│  tests/specs/   tests/perf/        tests/security/ scripts/*healer   │
│     │              │                  │              │               │
│     └──────────────┴───────┬──────────┴──────────────┘               │
│                            ▼                                         │
│                    EXECUTION RESULTS                                 │
│                 (test-results*.json, k6 json, ZAP xml)               │
│                            │                                         │
│          ┌─────────────────┼─────────────────┐                       │
│          ▼                 ▼                 ▼                       │
│     Custom HTML         Allure           Dashboard API               │
│     generate-report.js  generate-allure  src/api/                    │
│          │                 │                 │                       │
│          └─────────────────┼─────────────────┘                       │
│                            ▼                                         │
│             JIRA BUGS + ZEPHYR CYCLE + GIT SYNC + PR COMMENT         │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Repository Layout

| Folder / File | Purpose |
|---|---|
| [`.auth/`](.auth/) | Cached Playwright `storageState.json` (gitignored) |
| `.env` / [`.env.example`](.env.example) | Runtime secrets and SLA knobs |
| [`MIGRATION.md`](MIGRATION.md) | Deprecation schedule for legacy pipeline scripts (`qa-run.js`, `run-qa-complete.js`, `run-e2e.js`). Lists removal targets (v2.0.0), replacement commands, and step-by-step migration instructions. See also `logs/deprecation-warnings.log` for runtime audit trail. |
| [`.eslintrc.json`](.eslintrc.json) | Lint rules (strict mode, `const`/`let`, `eqeqeq`) |
| [`.github/`](.github/) | CI/CD workflows |
| `.story-testcases.json` | Auto-cached Zephyr → story mapping |
| [`Agentic_QA_Platform_Documentation.md`](Agentic_QA_Platform_Documentation.md) | This document |
| [`allure-report/`](allure-report/) | Allure interactive HTML |
| [`allure-results/`](allure-results/) | Raw Allure result JSONs from `allure-playwright` reporter |
| [`custom-report/`](custom-report/) | Self-contained HTML reports (functional, perf, security, applitools) |
| [`dashboard/`](dashboard/) | React dashboard (standalone npm package) |
| [`heal-artifacts/`](heal-artifacts/) | Baselines, diff masks, change manifest, heal report |
| [`logs/`](logs/) | Winston logs (`app.log`, `error.log`, per-run diagnostics), `agent-decisions.json` (agent observability), `deprecation-warnings.log` (legacy script usage audit), `pipeline-failure-report.{json,md}` (critical halt report), `preflight-report.json` (pre-flight check results), `secret-access.log` (secrets provider audit — G2), `cleanup-report.json` (artifact retention — G4), `.pipeline.lock` (runtime concurrency lock — G3) |
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

[`package.json`](package.json) — **`agentic-qa-platform` v1.0.0 (CommonJS, Node ≥ 18)**

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
| **Performance** | `perf`, `perf:load`, `perf:stress`, `perf:spike`, `perf:soak`, `perf:generate`, `perf:report`, `perf:dry-run`, `qa:with-perf` |
| **Security** | `security`, `security:no-zap`, `security:generate`, `security:report`, `qa:with-security` |
| **Combined** | `qa:complete`, `qa:complete:headless`, `e2e`, `e2e:headed`, `e2e:headless`, `e2e:no-perf`, `e2e:no-security`, `e2e:functional`, `e2e:ci` |
| **Healing** | `heal:classify`, `heal:visual`, `heal:dom`, `heal:api`, `heal:smart`, `heal:full`, `heal:dry-run`, `heal:update-baseline` |

---

## 5. Backend (`src/`)

### 5.1 Agents (`src/agents/`)

All agents are **rule-based** (keyword + context heuristics — no LLM calls).

| Agent | File | Responsibility |
|---|---|---|
| **Planner** | [src/agents/planner.agent.js](src/agents/planner.agent.js) | Reads Jira story, outputs `{ scope, testTypes[], designTechniques[], criticalScenarios[], risks[], confidence }`. Uses a **weighted keyword registry** (`{ keyword, weight: 1-3, category }`) scored per category and normalised to `0..1`; categories below `AGENT_CONFIDENCE_THRESHOLD` (default `0.4`) are dropped. Design techniques: **BVA**, **EP**, **DT**, **ST**, **EG**, **UC**. |
| **QA** | [src/agents/qa.agent.js](src/agents/qa.agent.js) | Generates `{ title, description, steps[], gwt[], priority, tags[] }` test cases. Emits **Given/When/Then/And** GWT lines. Applies the design techniques produced by the planner. **Fallback path**: when `plan.confidence < AGENT_CONFIDENCE_THRESHOLD`, always injects a minimum safety-net of Happy Path + Negative + Boundary cases. |
| **Reviewer** | [src/agents/reviewer.agent.js](src/agents/reviewer.agent.js) | Quality gate: Levenshtein-similarity dedup (≥ 0.85), ≥ 3 steps per case, non-empty expected results, priority normalisation (`High`/`Normal`/`Low`), lowercase tag arrays. |
| **Risk Prioritizer** | [src/agents/riskPrioritizer.agent.js](src/agents/riskPrioritizer.agent.js) | Scores each case on **Business Impact**, **Failure Likelihood**, **Defect Severity** (1–10). Composite score drives execution order. |
| **Executor** | [src/agents/executor.agent.js](src/agents/executor.agent.js) | Persists each test case to Zephyr (`POST /testcases`) and generates the matching Playwright spec. Per-case try/catch — individual Zephyr failures no longer abort the batch. Returns `{ createdKeys[] }`. |
| **Performance** | [src/agents/performance.agent.js](src/agents/performance.agent.js) | Detects perf signals (`load`, `latency`, `concurrent`, `sla`, `stress`, `volume`, `scalability`) → emits stages, thresholds, VU profiles. Feeds `perfScript.generator`. |
| **Security** | [src/agents/security.agent.js](src/agents/security.agent.js) | Detects security signals (`auth`, `rbac`, `injection`, `xss`, `csrf`, `encryption`…) → maps to **OWASP Top 10 2021**, emits ZAP scan config + custom checks. |
| **Decision Log** | [src/agents/agentDecisionLog.js](src/agents/agentDecisionLog.js) | Fail-safe append-only observability store. Every agent calls `logDecision(agentName, input, output, reasoning)` which writes to `logs/agent-decisions.json` (cap: 2000 entries). Never throws — broken observability cannot break pipelines. |

**Schema validation.** Every agent validates its output against [src/core/schemas.js](src/core/schemas.js) before returning. Invalid outputs are **sanitised** (not thrown) so one broken case cannot fail the whole run; a `warn` is logged instead.

#### 5.1.1 Planner weighted keyword registry

The planner loads a single in-memory table where each row binds a lowercase keyword to a **weight** (`1` = weak hint, `2` = strong hint, `3` = explicit requirement) and a **category** (one of: `happyPath`, `negative`, `edgeCase`, `uiValidation`, `security`, `boundary`, `integration`, `performance`, `accessibility`, `rbac`).

```js
// src/agents/planner.agent.js  (excerpt)
const WEIGHTED_KEYWORDS = [
  { keyword: 'login',        weight: 2, category: 'happyPath' },
  { keyword: 'invalid',      weight: 3, category: 'negative'  },
  { keyword: 'sql injection',weight: 3, category: 'security'  },
  { keyword: 'p95',          weight: 3, category: 'performance' },
  // … ~60 rows across 10 categories
];
```

**Scoring pipeline:**

1. Concatenate `summary + description + acceptance criteria` into a single lowercase blob.
2. For each row, if `blob.includes(keyword)` add `weight` to `categoryScores[category]`.
3. Compute `topScore = max(categoryScores)` (guard against zero).
4. Normalise each category to `confidence = categoryScore / topScore` (range `0–1`).
5. Drop categories whose `confidence < AGENT_CONFIDENCE_THRESHOLD` (default `0.4`).
6. Emit `plan.confidence = average(kept confidences)` and `plan.testTypes = keptCategories`.

The legacy `TYPE_SIGNALS` export is still produced (derived from the registry) so any external consumer continues to receive the original flat object.

#### 5.1.2 QA low-confidence fallback

When `plan.confidence < AGENT_CONFIDENCE_THRESHOLD` **or** no test cases would otherwise be generated, the QA agent always injects a **safety-net trio**:

| Fallback case  | Priority | Technique | Tag         |
|----------------|----------|-----------|-------------|
| Happy Path     | High     | EP        | `fallback`  |
| Negative       | High     | EP        | `fallback`  |
| Boundary       | Normal   | BVA       | `fallback`  |

Each fallback case carries GWT lines derived from the story subject, the `fallback` tag, and is then passed back through the normal reviewer + risk-prioritiser pipeline. The decision log records `fallbackApplied: true` with the triggering confidence value for later audit.

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
| [src/api/agentDecisions.controller.js](src/api/agentDecisions.controller.js) | `GET /agent-decisions?limit=N&agentName=X` (authed; `limit` 1–200; newest-first). Surfaces the decision log for dashboards and audits. |

### 5.3 Core (`src/core/`)

| File | Responsibility |
|---|---|
| [src/core/config.js](src/core/config.js) | Single source of truth for all `.env` values: Jira, Zephyr, SLAs (per-test-type), baseline tolerances, logging level, and `agent.confidenceThreshold` (from `AGENT_CONFIDENCE_THRESHOLD`, default `0.4`). |
| [src/core/errorHandler.js](src/core/errorHandler.js) | `AppError` base + subclasses: `TimeoutError`, `NonZeroExitError`, `SpawnError`, `UpstreamError`, `PreconditionError`. Each carries `code`, `status`, `recoveryHint`, `details` and serialises via `toJSON()`. Default export remains `AppError` for backward compatibility. |
| [src/core/schemas.js](src/core/schemas.js) | Zero-dependency validators + sanitisers for `PlannerOutput`, `QAOutput`, `ReviewerOutput`, `RiskPrioritizerOutput`, `ExecutorOutput`. Each schema has a `validate*` (`{ valid, errors[] }`) and a `sanitize*` that fills defaults. JSDoc `@typedef` exports power IDE autocompletion. |

### 5.4 Orchestrator (`src/orchestrator/`)

| File | Responsibility |
|---|---|
| [src/orchestrator/agentOrchestrator.js](src/orchestrator/agentOrchestrator.js) | `runAgentFlow(issueKey)` → Jira → `planner.plan` → `qa.generate` → `reviewer.review` → `riskPrioritizer.prioritize` → `executor.execute`. Returns `{ story, testCases, createdKeys }`. |
| [src/orchestrator/finalFlow.js](src/orchestrator/finalFlow.js) | Higher-level coordination across execute + report + sync stages. |

### 5.5 Services (`src/services/`)

| File | Responsibility |
|---|---|
| [src/services/execution.service.js](src/services/execution.service.js) | `runPlaywright()` — spawns Playwright via `child_process`, 10 MB buffer, timeout from `PLAYWRIGHT_EXEC_TIMEOUT_MS` (default 300 s). Classifies failures into `TimeoutError` / `SpawnError` / `NonZeroExitError` with actionable `recoveryHint`s. |
| [src/services/cycle.service.js](src/services/cycle.service.js) | `setupCycle(storyKey, story)` — creates/links Zephyr test cycle. |
| [src/services/bug.service.js](src/services/bug.service.js) | `createBugsForFailures(results, parentKey)` — one Jira bug per failed test. |
| [src/services/flaky.service.js](src/services/flaky.service.js) | Sliding-window flakiness detection (last 5 of 100 runs). |
| [src/services/coverage.service.js](src/services/coverage.service.js) | Story coverage aggregation. |
| [src/services/executionMapping.service.js](src/services/executionMapping.service.js) | Playwright-test-name → Zephyr-test-case resolution. Also exposes `validateMapping(storyKey)` returning `{ valid, testCaseCount, missingKeys, reason? }` — used by the pipeline runner to abort early when specs are missing for handoff keys. |
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
| [src/tools/perfScript.generator.js](src/tools/perfScript.generator.js) | `generateK6Script(story, perf)` — k6 scripts with valid threshold syntax (`'metric': ['p(95)<X', …]`) and no invalid top-level options. |
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

Consolidated orchestration layer introduced to replace the copy-pasted `STAGES[]` arrays across the four legacy pipeline scripts. All new automation should build on this package; the legacy scripts ([`qa-run.js`](scripts/qa-run.js), [`run-qa-complete.js`](scripts/run-qa-complete.js), [`run-e2e.js`](scripts/run-e2e.js)) carry `@deprecated` banners and are retained for backward compatibility only.

| File | Responsibility |
|---|---|
| [src/pipeline/steps.js](src/pipeline/steps.js) | 12 named async steps: `ensureDirs`, `preFlight`, `fetchStory`, `generateSpecs`, `proactiveHeal`, `executeFunctional`, `executePerformance`, `executeSecurity`, `reactiveHeal`, `createBugs`, `generateReports`, `syncGit`. Each is `async (ctx) => ctx`, throws classified `AppError` subclasses, never calls `process.exit`. The runner iterates the preset sequentially — `executePerformance` and `executeSecurity` are independent non-critical steps, each classified individually; a failure in one does not abort the other. |
| [src/pipeline/runner.js](src/pipeline/runner.js) | `runPipeline(stepNames, ctx)` → `{ passed, failed, warned, skipped, steps[], halted, durationMs }`. Critical step failure halts the run and writes `logs/pipeline-failure-report.json` with the classified error + recovery hint. |
| [src/pipeline/presets.js](src/pipeline/presets.js) | Named sequences: `functional`, `full`, `scoped` (CI), `perfOnly`, `secOnly`. |

**Opt-in from the legacy wrapper:**

```bash
node scripts/run-full-pipeline.js --use-runner --include-perf --include-security
# equivalent to:
npm run pipeline:full
```

Setting `PIPELINE_USE_RUNNER=true` in the environment has the same effect. Without the flag, [`run-full-pipeline.js`](scripts/run-full-pipeline.js) retains its original `STAGES[]` path verbatim — existing CI integrations are unchanged.

> **Deprecation note.** `--use-runner` / `PIPELINE_USE_RUNNER=true` are the currently-shipping opt-in switches. A future major release will make the consolidated runner the default and remove the legacy `STAGES[]` path; `npm run pipeline:full` and the CI workflow already use the runner today, so no action is required for new integrations.

**Step contract.** Every step in [src/pipeline/steps.js](src/pipeline/steps.js) conforms to:

```js
// signature
async function stepName(ctx) { /* mutate ctx, return ctx */ }

// registration
STEPS.stepName = { fn: stepName, critical: true | false };
```

A step that throws an `AppError` subclass is classified by the runner:

| Thrown                 | Runner outcome                                                        |
|------------------------|-----------------------------------------------------------------------|
| `TimeoutError`         | `failed++`; if `critical` → halt + failure-report                     |
| `NonZeroExitError`     | `failed++`; if `critical` → halt + failure-report                     |
| `SpawnError`           | `failed++`; always halt (binary missing is unrecoverable)             |
| `UpstreamError`        | `failed++`; if `critical` → halt; otherwise `warned++` and continue   |
| `PreconditionError`    | `failed++`; always halt (e.g. zero specs to execute)                  |
| Any other `Error`      | Re-wrapped as `AppError`; `failed++`; halt if `critical`              |

**Runner result shape:**

```js
{
  passed:    3,                       // steps that completed OK
  failed:    1,                       // steps that threw
  warned:    0,                       // non-critical failures that were swallowed
  skipped:   2,                       // steps after a critical halt
  halted:    true,                    // true iff a critical step failed
  durationMs: 184321,
  steps: [
    { name: 'preFlight',       outcome: 'passed',  durationMs:   612 },
    { name: 'fetchStory',      outcome: 'passed',  durationMs:  1128 },
    { name: 'generateSpecs',   outcome: 'failed',
      error: { class: 'PreconditionError', code: 'PRECONDITION_FAILED',
               recoveryHint: 'Re-run scripts/run-story.js …' } },
    { name: 'executeFunctional', outcome: 'skipped' }
  ]
}
```

On `halted: true`, the runner writes `logs/pipeline-failure-report.json` (full result) **and** `logs/pipeline-failure-report.md` (human-readable summary consumed by the GitHub Actions step-summary preview).

### 5.9 Server Entry (`src/main.js`)

- Boots Express on `PORT` (default `3000`).
- Validates `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` at startup.
- Mounts [src/api/routes.js](src/api/routes.js).
- Serves the dashboard static assets and webhook endpoints.

---

## 6. Test Suite (`tests/`)

### 6.1 `tests/specs/` — auto-generated Playwright specs

Current inventory (SCRUM-T172 … SCRUM-T188) covers the employee-creation story end-to-end: duplicates, session timeout, concurrent access, navigation, autofill, happy path, mandatory fields, invalid data, boundaries, special characters, cancellation, persistence, maximum records, RBAC, slow network, UI feedback, and keyboard accessibility. See [tests/specs/](tests/specs/).

### 6.2 `tests/pages/` — Page Object Model (POM)

| Page | Class | Locators (YAML) |
|---|---|---|
| Login | [LoginPage.js](tests/pages/LoginPage.js) | [LoginPage.yml](tests/pages/LoginPage.yml) — `usernameInput`, `passwordInput`, `loginButton`, `errorAlert` |
| Add Employee | [AddEmployeePage.js](tests/pages/AddEmployeePage.js) | [AddEmployeePage.yml](tests/pages/AddEmployeePage.yml) |
| Employee List | [EmployeeListPage.js](tests/pages/EmployeeListPage.js) | [EmployeeListPage.yml](tests/pages/EmployeeListPage.yml) |

Selectors live in YAML files and are loaded at class construction by [tests/helpers/locatorLoader.js](tests/helpers/locatorLoader.js) — this indirection is what makes [`proactive-healer.js`](scripts/proactive-healer.js) able to auto-repair broken locators without touching JavaScript.

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
- [tests/security/](tests/security/) — ZAP scan configs (e.g. `SCRUM-5-scan-config.json`), `sec-testcase-map.json`.
- [tests/healed/](tests/healed/) — backups of spec files patched by [`healer.js`](scripts/healer.js) and [`proactive-healer.js`](scripts/proactive-healer.js).

### 6.5 Global lifecycle

- [tests/global-setup.js](tests/global-setup.js) — health-checks the AUT, authenticates once, caches `storageState.json`, ensures output directories exist.
- [tests/global-teardown.js](tests/global-teardown.js) — final summary logging.

---

## 7. Operational Scripts (`scripts/`)

| Script | Role |
|---|---|
| **Full pipelines** | |
| [run-full-pipeline.js](scripts/run-full-pipeline.js) | 8-stage autonomous run (story → execution → heal → bugs → reports → git). |
| [qa-run.js](scripts/qa-run.js) | 9-stage functional pipeline, opt-in perf/security. |
| [run-qa-complete.js](scripts/run-qa-complete.js) | 14-stage unified functional + perf + security. |
| [run-e2e.js](scripts/run-e2e.js) | 15-stage PREPARE / EXECUTE / REPORT supersystem. |
| **Pillar runners** | |
| [run-perf.js](scripts/run-perf.js) | 6-stage k6 pipeline: generate → execute → evaluate → sync → report → git. |
| [run-security.js](scripts/run-security.js) | 7-stage ZAP pipeline, incl. reachability checks. |
| [run-story-tests.js](scripts/run-story-tests.js) | 7-stage per-story Playwright run. |
| [run-tagged-tests.js](scripts/run-tagged-tests.js) | Tag-aliased Playwright run (`smoke`, `regression`, `bva`, `ep`, `negative`, …). |
| [run-and-sync.js](scripts/run-and-sync.js) | Lightweight execute-and-sync helper. |
| **Generators** | |
| [generate-playwright.js](scripts/generate-playwright.js) | Zephyr → Playwright spec scaffolding. |
| [generate-perf-scripts.js](scripts/generate-perf-scripts.js) | Story → k6 scripts via `performance.agent`. |
| [generate-sec-scripts.js](scripts/generate-sec-scripts.js) | Story → ZAP config via `security.agent`. |
| **Reports** | |
| [generate-report.js](scripts/generate-report.js) | Custom functional HTML (pie chart, per-test cards, embedded media). |
| [generate-perf-report.js](scripts/generate-perf-report.js) | Chart.js-powered perf HTML. Scans `test-results/perf/*.json` **excluding** `*-summary.json` (k6 `--summary-export` output consumed internally by `parsePerfResults`) and `*-thresholds.json` (metadata snapshot from `saveThresholdsForRun`) — feeding those siblings to the parser was producing spurious `summary-export missing` warnings and empty rows in the report. |
| [generate-sec-report.js](scripts/generate-sec-report.js) | OWASP-mapped ZAP HTML. |
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
| [pre-flight.js](scripts/pre-flight.js) | Parallel health checks (< 10 s, `Promise.allSettled`): `ISSUE_KEY` present, dirs created if missing, Jira `GET /myself` OK, Zephyr `GET /healthcheck` OK, `k6` on PATH (critical when `--include-perf`), ZAP/docker available (critical when `--include-security`). Exit 1 on any critical failure. Full check matrix below. |
| [ensure-dirs.js](scripts/ensure-dirs.js) | Guarantees all output directories exist. |
| [cleanup-artifacts.js](scripts/cleanup-artifacts.js) | **Artifact retention sweeper (G4).** Deletes `test-results/`, `playwright-report/`, `allure-*`, `custom-report/`, `screenshots/`, `heal-artifacts/` files older than `ARTIFACT_RETENTION_DAYS` (default 30). Supports `--dry-run` and `--aggressive` (half retention). Writes rolling summary to `logs/cleanup-report.json`. Scheduled nightly by the `artifact-cleanup` GH Actions job. Preserves `.gitkeep` and the entire `logs/` tree. |
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

Delegates to [`src/pipeline/runner.js`](src/pipeline/runner.js) with a preset from [`src/pipeline/presets.js`](src/pipeline/presets.js) (`PIPELINE_PRESET` env, default `full`). Adds:

- A mandatory **pre-flight** step that fails fast on credential/tool issues.
- Per-step classified errors (`TimeoutError` / `NonZeroExitError` / `SpawnError` / `PreconditionError`) with `recoveryHint`.
- Critical-step halt + `logs/pipeline-failure-report.json` on hard failure.
- A proper non-zero exit code — the CI workflow no longer needs `continue-on-error: true`.

### 8.2 `qa-run.js` — 9 stages (functional-only default)

Fetches Jira → creates Zephyr TCs → runs Playwright → heals → bugs → reports. Flags: `--run-only`, `--skip-story`, `--include-perf`, `--include-security`.

### 8.3 `run-qa-complete.js` — 14 stages (tri-pillar)

Orchestrates functional (Playwright) + perf (k6) + security (OWASP ZAP). Flags: `--headless`, `--skip-functional`, `--skip-perf`, `--skip-security`, `--no-zap`, `--skip-bugs`, `--skip-git`.

### 8.4 `run-e2e.js` — 15 stages (PREPARE / EXECUTE / REPORT)

Generates every artifact, executes every pillar, syncs to Zephyr/Jira, produces every report. Modular `--skip-*` flags throughout.

### 8.5 Story- and tag-scoped runs

- [run-story-tests.js](scripts/run-story-tests.js) — resolves Zephyr test cases for an `ISSUE_KEY`, runs only those, then heals + reports + syncs.
- [run-tagged-tests.js](scripts/run-tagged-tests.js) — two-level filter (filename + Playwright `--grep`) with tag aliases for technique coverage.

---

## 9. Self-Healing Subsystem

The platform ships **three healers** operating at different points in the lifecycle:

| Dimension | `healer.js` | `smart-healer.js` | `proactive-healer.js` |
|---|---|---|---|
| **Trigger** | After test failures | After `git diff` | Before Playwright run |
| **Input** | `test-results.json` | git diff | [`impact-manifest.json`](./impact-manifest.json) (from `analyse-impact.js`) |
| **Scope** | Specs only (timeouts, strict mode, visibility, selectors) | POM YAML + specs + Zephyr | POM YAML + specs + Zephyr via live browser probe |
| **Browser** | No | No | **Yes** — headless Chromium probe |
| **Output** | `test-results-healed.json` | `change-manifest.json` + `smart-healing-report.json` | Healed YAML, Zephyr PUTs, patched specs, optional re-run |
| **Manual review** | Not applicable | Exit 1 signals required review | `manual-review-needed` status per locator |

### 9.1 Proactive Healer workflow

```
┌──────────────────────────┐
│  git diff HEAD~1 HEAD    │
└────────────┬─────────────┘
             ▼
   analyse-impact.js  ──►  impact-manifest.json
             │             (affectedPages, affectedSpecFiles,
             │              affectedTestKeys, zephyrTestCases)
             ▼
   proactive-healer.js
             │
   ┌─────────┼──────────────────────────────────────────┐
   ▼         ▼                                          ▼
 (A) POM heal            (B) Zephyr update       (C) Spec patch
  • chromium probe        • rewrite steps         • string-replace
  • count() === 0         • PUT /testcases/{key}  • backup → tests/healed/
  • aria/name/placeholder • [auto-healed <date>]  • // proactive-healed: …
    /data-testid recovery                         • atomic rename
  • atomic YAML write
             │
             ▼
   Optional: npx playwright test --grep "<keys>"
             │
             ▼
      test-results-healed.json  +  summary box
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

[`performance.agent.js`](src/agents/performance.agent.js) analyses the story for signals (`load`, `latency`, `concurrent`, `sla`, `stress`, `volume`, `scalability`) and emits stages / thresholds / VU profiles. [`perfScript.generator.js`](src/tools/perfScript.generator.js) converts that into k6 scripts using **valid k6 threshold syntax**:

```js
thresholds: {
  'login_duration':    ['p(50)<1080', 'p(90)<2400', 'p(95)<3000'],
  'navigate_duration': ['p(50)<900',  'p(90)<1800', 'p(95)<2250'],
  'action_duration':   ['p(50)<700',  'p(90)<1400', 'p(95)<1750'],
}
```

(Top-level `gracefulStop` has been removed — k6 v1.0 rejects it.)

### 10.3 Execution

[`run-perf.js`](scripts/run-perf.js) stages: **generate → execute → evaluate SLAs → sync Zephyr/Jira → report → git sync**. Binary path overridable via `PERF_K6_BINARY`. Flags: `--test-type`, `--dry-run`, `--skip-generate`, `--skip-sync`, `--skip-git`.

### 10.4 Reporting

[`generate-perf-report.js`](scripts/generate-perf-report.js) renders per-test-type dashboards with Chart.js, SLA breach markers, and baseline deltas. Aggregated via `GET /perf/summary`.

**Input discipline (standalone CLI path).** The CLI entry point (`npm run perf:report`, Stage 12 of [`run-e2e.js`](scripts/run-e2e.js)) globs `test-results/perf/` and filters to raw k6 NDJSON files only:

```js
const files = fs.readdirSync(resultsDir).filter(f =>
  f.endsWith('.json') &&
  !f.endsWith('-summary.json') &&   // k6 --summary-export output (read BY parsePerfResults)
  !f.endsWith('-thresholds.json')   // metadata snapshot from saveThresholdsForRun
);
```

[`scripts/run-perf.js`](scripts/run-perf.js) is unaffected — it builds its `allResults` from `runOneScript()` return values and never scans the directory.

---

## 11. Security Testing Subsystem

### 11.1 Scan generation

[`security.agent.js`](src/agents/security.agent.js) detects security signals and maps them to **OWASP Top 10 2021**. [`secScript.generator.js`](src/tools/secScript.generator.js) emits scan configs (target URLs, scan types, policies, custom checks).

### 11.2 Execution

[`run-security.js`](scripts/run-security.js) — 7 stages: generate config → start ZAP (docker or local) → run scans → evaluate findings → sync → report → git. `--no-zap` flag skips container boot when ZAP is unreachable in CI.

### 11.3 Reporting

[`generate-sec-report.js`](scripts/generate-sec-report.js) colours findings by severity (`critical`, `high`, `medium`, `low`, `informational`) and groups by OWASP category. Aggregated via `GET /security/summary`.

---

## 12. Reporting & Dashboard

| Output | Location | Generator |
|---|---|---|
| Custom functional HTML | [custom-report/index.html](custom-report/index.html) | [generate-report.js](scripts/generate-report.js) |
| Applitools visual HTML | [custom-report/applitools-report.html](custom-report/applitools-report.html) | Applitools Eyes SDK (optional) |
| Performance HTML | `custom-report/perf/index.html` | [generate-perf-report.js](scripts/generate-perf-report.js) |
| Security HTML | `custom-report/security/index.html` | [generate-sec-report.js](scripts/generate-sec-report.js) |
| Allure HTML | [allure-report/index.html](allure-report/index.html) | [generate-allure-report.js](scripts/generate-allure-report.js) |
| Playwright HTML | [playwright-report/](playwright-report/) | Playwright built-in |
| Logs | [logs/app.log](logs/), [logs/error.log](logs/) | Winston |
| Healing artefacts | [heal-artifacts/](heal-artifacts/) | visual/dom/api-diff + smart-healer |
| React dashboard | [dashboard/](dashboard/) | Standalone npm package |

---

## 13. CI/CD — GitHub Actions

| Workflow | Trigger | Jobs |
|---|---|---|
| [.github/workflows/qa.yml](.github/workflows/qa.yml) | `push` to `main` + manual | `qa` — installs Node 20 + Playwright + k6 + ZAP docker, runs **`scripts/pre-flight.js`** first (fail-fast on credentials/tools), then **`scripts/run-full-pipeline.js --use-runner --include-perf --include-security --headless`**. Uploads `logs/pipeline-failure-report.json` on failure. No more `continue-on-error: true` — real failures now fail the workflow. |
| [.github/workflows/smart-proactive-heal.yml](.github/workflows/smart-proactive-heal.yml) | `push` (ignoring heal artifacts) | `classify` → `diff` → `heal` → `report`. Each gated by the previous step's outputs. |
| [.github/workflows/scoped-qa.yml](.github/workflows/scoped-qa.yml) | `pull_request`, `push main`, `workflow_dispatch` | `scoped-execution` — runs `analyse-impact.js`, calls `proactive-healer.js --skip-run` when `affectedTestKeys > 0`, then executes story/tag/full scope, posts GITHUB_STEP_SUMMARY + PR comment. |

---

## 14. Configuration Reference

### 14.1 `.env.example` keys (values redacted)

**Credentials:** `OPENAI_API_KEY`, `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `PROJECT_KEY`, `ISSUE_KEY`, `ZEPHYR_BASE_URL`, `ZEPHYR_ACCESS_KEY`, `PORT`.
**Agents:** `AGENT_CONFIDENCE_THRESHOLD` (default `0.4`).
**Pipeline:** `PIPELINE_USE_RUNNER` (`true`/`false`), `PIPELINE_PRESET` (`functional` | `full` | `scoped` | `perfOnly` | `secOnly`), `PLAYWRIGHT_EXEC_TIMEOUT_MS` (default `300000`).
**Webhooks:** `WEBHOOK_SECRET`, `WEBHOOK_TRIGGER_STATUSES`.
**API auth:** `API_SECRET`.
**Performance:** `PERF_K6_BINARY`, `PERF_LOAD_P95`, `PERF_LOAD_P99`, `PERF_LOAD_ERROR`, `PERF_STRESS_*`, `PERF_SPIKE_*`, `PERF_SOAK_*`, `PERF_SCALE_*`, `PERF_BREAK_*`, `PERF_BASELINE_TOLERANCE_{P95,P99,AVG,ERR}`, `PERF_VUS_MAX`, `PERF_SOAK_DURATION`, `PERF_SKIP_SOAK`.
**Security:** `ZAP_API_URL`, `ZAP_API_KEY`, `ZAP_DOCKER`, `ZAP_SCAN_TYPE`, `ZAP_FAIL_ON`.
**AUT:** `BASE_URL`, `AUT_USERNAME`, `AUT_PASSWORD`.
**Visual:** `APPLITOOLS_API_KEY`, `USE_ULTRAFAST_GRID`, `APPLITOOLS_CONCURRENCY`, `APPLITOOLS_BATCH_ID`.

### 14.2 `playwright.config.js` highlights

| Setting | Value |
|---|---|
| `testDir` | `./tests/specs` |
| `timeout` | 90 000 ms |
| `retries` | 1 |
| `workers` | 3 (overridable via `PW_WORKERS`) |
| `fullyParallel` | `true` |
| `grep` | `PW_GREP` env |
| Reporters | `list`, `json`, `html`, `allure-playwright` |
| `baseURL` | `https://opensource-demo.orangehrmlive.com` |
| `headless` | `PW_HEADLESS` env |
| Media | `screenshot: only-on-failure`, `video/trace: retain-on-failure` |
| `launchOptions` | `slowMo: 50` (headed only) |

### 14.3 ESLint rules

`strict: ["warn","global"]`, `no-unused-vars` (ignore `^_`), `eqeqeq: error`, `no-var: error`, `prefer-const: warn`, `no-throw-literal: error`, `no-eval: error`.

---

## 15. External Integrations

| System | Protocol / Client | Usage |
|---|---|---|
| **Jira** | REST v3 (basic auth) | Story fetch, bug creation, issue links |
| **Zephyr Scale** | Essential Cloud API v2.8 (bearer token) | Test case + cycle + execution CRUD |
| **Playwright** | `@playwright/test` | Functional + visual base |
| **k6** | Binary spawn (`PERF_K6_BINARY`) | Performance |
| **OWASP ZAP** | Docker or API | Security scanning |
| **Applitools Eyes** | JS SDK (opt-in) | Visual regression |
| **Allure** | `allure-commandline` + `allure-playwright` | Interactive reporting |
| **GitHub Actions** | Workflow YAML | CI/CD |
| **Winston** | npm | Logging |
| **Express** | npm | REST API |

---

## 16. End-to-End Execution Flows

### 16.1 Push-driven full run

```
git push
  │
  ▼
qa.yml (GitHub Actions)
  │
  ├── Stage 0  scripts/pre-flight.js --include-perf --include-security      ← fail-fast
  └── scripts/run-full-pipeline.js --use-runner --include-perf
                                    --include-security --headless
        │
        ├── preFlight           (critical)
        ├── ensureDirs          (critical)
        ├── fetchStory          (critical)      → Jira → agent pipeline → Zephyr
        ├── generateSpecs       (critical)      → exit 2 on zero specs → PreconditionError
        ├── proactiveHeal       (non-critical)
        ├── executeFunctional   (critical)
        ├── executePerformance  (non-critical)    → k6 per test-type
        ├── executeSecurity     (non-critical)    → OWASP ZAP
        ├── reactiveHeal        (non-critical)
        ├── createBugs          (non-critical)
        ├── generateReports     (non-critical)   → custom + Allure + decision-log section
        └── syncGit             (non-critical)
        │
        ▼
   On critical halt: logs/pipeline-failure-report.{json,md} uploaded as CI artefact.
```

### 16.2 Pull-request scoped flow

```
pull_request opened
  │
  ▼
scoped-qa.yml
  │
  ├── analyse-impact.js      → impact-manifest.json
  ├── (if affected > 0)
  │     └── proactive-healer.js --skip-run
  ├── Execute scope (story | tag | full)
  ├── Job summary → GITHUB_STEP_SUMMARY
  └── PR comment (affected pages, heal counts, pass/fail)
```

### 16.3 Jira-webhook-driven flow

```
Jira status change
  │
  ▼
POST /webhook/jira (HMAC-SHA256 verified)
  │
  ▼
webhook.controller.js
  │
  ├── Filter by project + issuetype + status
  └── spawn scripts/run-full-pipeline.js $ISSUE_KEY
```

---

## 17. Extending the Platform

| Need | How |
|---|---|
| Add a new page object | Create `tests/pages/NewPage.yml` + `NewPage.js` and extend `PAGE_OBJECT_MAP` in [scripts/analyse-impact.js](scripts/analyse-impact.js) and `PAGE_ROUTES` in [scripts/proactive-healer.js](scripts/proactive-healer.js). |
| Add a new perf test type | Extend the list in [src/agents/performance.agent.js](src/agents/performance.agent.js), mirror SLA envs in `.env.example`, teach [scripts/run-perf.js](scripts/run-perf.js) the new `--test-type` value. |
| Add a new OWASP check | Extend [src/agents/security.agent.js](src/agents/security.agent.js) detection + [src/tools/secScript.generator.js](src/tools/secScript.generator.js) template. |
| Plug in an LLM | Wire [src/utils/openai.js](src/utils/openai.js) into `qa.agent` / `planner.agent` behind a feature flag. |
| Add a new report | Drop a generator under `scripts/generate-*-report.js`, output to `custom-report/<name>/index.html`, expose via `src/api/*.controller.js`. |
| Add a new CI trigger | Add a workflow under [.github/workflows/](.github/workflows/) and re-use the existing runner scripts. |
| Add a new pipeline step | Implement `async function myStep(ctx)` in [src/pipeline/steps.js](src/pipeline/steps.js), register it in the `STEPS` map with `{ fn, critical }`, then add its name to the desired preset in [src/pipeline/presets.js](src/pipeline/presets.js). |
| Add a new agent schema | Add `validate*` / `sanitize*` functions and a JSDoc `@typedef` to [src/core/schemas.js](src/core/schemas.js), add ≥ 3 valid and ≥ 3 invalid fixtures to [tests/unit/schemas.test.js](tests/unit/schemas.test.js), run `npm run test:unit`. |

---

## 18. Observability & Schema Contracts

### 18.1 Agent Decision Log

Every agent call appends one JSON entry to `logs/agent-decisions.json` via [`agentDecisionLog.js`](src/agents/agentDecisionLog.js):

```json
{
  "timestamp":  "2026-04-21T10:15:03.241Z",
  "agentName":  "planner",
  "input":      { "storyKey": "SCRUM-6", "title": "Add employee", "wordCount": 48 },
  "output":     { "testTypes": ["Happy Path", "Negative"], "overallConfidence": 0.82 },
  "reasoning":  { "matchedKeywords": [...], "scoredCategories": [...], "confidenceThreshold": 0.4 }
}
```

Properties: **append-only**, **capped at 2000 entries** (oldest pruned), **never throws** (wrapped in try/catch — observability must not break pipelines). Newest-first on read.

### 18.2 API — `GET /agent-decisions`

Authed endpoint ([src/api/agentDecisions.controller.js](src/api/agentDecisions.controller.js)):

| Query param | Type    | Default | Range    | Description                       |
|-------------|---------|---------|----------|-----------------------------------|
| `limit`     | integer | 50      | 1–200    | Max entries returned              |
| `agentName` | string  | —       | any      | Filter by agent (`planner`, …)    |

Responses: `200 { total, entries[] }`  ·  `400` on invalid params.

### 18.3 Custom HTML Report — Agent Decisions section

[`generate-report.js`](scripts/generate-report.js) appends a **collapsed `<details>` block per agent** showing the last 20 decisions with timestamp, techniques applied, and confidence. Gracefully skipped when the log file is absent.

### 18.4 Schema Validators

[src/core/schemas.js](src/core/schemas.js) exports `validate*` / `sanitize*` pairs for all five agent outputs plus `QATestCase`. Behaviour at agent boundaries:

1. Agent builds output.
2. `validate*(output)` runs.
3. On failure → `logger.warn('schema validation failed — sanitising')` and `sanitize*()` fills defaults.
4. Validated/sanitised output is returned **and** passed to `logDecision`.

This is enforced by **37 unit tests** under [tests/unit/schemas.test.js](tests/unit/schemas.test.js) (≥ 3 valid + ≥ 3 invalid fixtures per schema). Run with:

```bash
npm run test:unit
```

### 18.5 Schema shapes (canonical)

```ts
// PlannerOutput
{
  scope: string,
  testTypes: string[],                 // subset of the 10 categories
  designTechniques: ('BVA'|'EP'|'DT'|'ST'|'EG'|'UC')[],
  criticalScenarios: string[],
  risks: string[],
  confidence: number                   // 0..1
}

// QATestCase (element of QAOutput[])
{
  title: string,
  description: string,
  steps: string[],                     // >= 3
  gwt: string[],                       // Given/When/Then/And lines
  priority: 'High' | 'Normal' | 'Low',
  tags: string[]                       // lowercase
}

// RiskPrioritizerOutput (element)
{
  ...QATestCase,
  businessImpact: 1..10,
  failureLikelihood: 1..10,
  defectSeverity: 1..10,
  compositeRisk: number,               // weighted sum
  riskScore: 'Low' | 'Medium' | 'High' | 'Critical'
}

// ExecutorOutput
{
  createdKeys: string[],               // e.g. ['SCRUM-T172', ...]
  failures: { title: string, reason: string }[]
}
```

---

## 19. Error Taxonomy & Recovery Hints

All programmatic errors raised by agents, services, and pipeline steps extend `AppError` from [src/core/errorHandler.js](src/core/errorHandler.js). The runner classifies every step failure and surfaces the `recoveryHint` in logs and in `logs/pipeline-failure-report.json`.

| Class              | `code`                 | `status` | Typical trigger                                            | Recovery hint (default)                                                           |
|--------------------|------------------------|----------|------------------------------------------------------------|-----------------------------------------------------------------------------------|
| `AppError`         | `APP_ERROR`            | 500      | Base class — generic failure                               | —                                                                                 |
| `TimeoutError`     | `TIMEOUT`              | 504      | Playwright / step exceeded wall-clock limit                | Increase timeout via env var or reduce workload scope.                            |
| `NonZeroExitError` | `NON_ZERO_EXIT`        | 500      | Child process ran to completion but returned non-zero      | Inspect stdout/stderr for the actual failure and re-run.                          |
| `SpawnError`       | `SPAWN_FAILED`         | 500      | Binary missing / EACCES / ENOENT                           | Verify the binary is installed and on PATH (`where k6` / `where npx`).            |
| `UpstreamError`    | `UPSTREAM_UNAVAILABLE` | 502      | Jira, Zephyr, ZAP not reachable                            | Verify credentials and connectivity to the upstream service.                      |
| `PreconditionError`| `PRECONDITION_FAILED`  | 412      | Zero specs generated, missing handoff file, missing inputs | Run the prior stage or ensure required inputs exist.                              |
| `NonZeroExitError` | `BUFFER_OVERFLOW`      | 500      | Playwright stdout exceeded `PLAYWRIGHT_MAX_BUFFER_MB`      | Raise `PLAYWRIGHT_MAX_BUFFER_MB` or set `PLAYWRIGHT_STREAM_OUTPUT=true`.           |

**Zero-spec guard.** [`scripts/generate-playwright.js`](scripts/generate-playwright.js) exits with **code `2`** (distinct from `1`) whenever it writes no specs. The `generateSpecs` step in [src/pipeline/steps.js](src/pipeline/steps.js) converts that into a `PreconditionError` with a specific recovery hint ("Re-run scripts/run-story.js…"), which halts the pipeline before functional execution would have failed en masse.

**Pre-flight short-circuit.** Each `npm run preflight` check is a `Promise.allSettled` outcome; **critical** failures (Jira auth, Zephyr auth, missing `ISSUE_KEY`, missing `k6` when `--include-perf`, missing ZAP when `--include-security`) exit 1 before any expensive work starts.

### 19.1 Pre-flight check matrix

| # | Check                  | How                                          | Critical when                          |
|---|------------------------|----------------------------------------------|----------------------------------------|
| 1 | `ISSUE_KEY` present    | `process.env.ISSUE_KEY` regex `^[A-Z]+-\d+$` | Always                                 |
| 2 | Output dirs ready      | `fs.mkdirSync({ recursive: true })` on 10 required dirs — creates if missing, no-op if present. Eliminates fresh-checkout failure. | Always |
| 3 | Jira auth              | Native `fetch` → `GET /rest/api/3/myself`    | Always                                 |
| 4 | Zephyr auth            | `GET /healthcheck` with bearer token         | Always                                 |
| 5 | `k6` on PATH           | `where k6` / `which k6` or `PERF_K6_BINARY` resolvable | `--include-perf`             |
| 6 | ZAP reachable          | `GET ZAP_API_URL/JSON/core/view/version/`    | `--include-security` (not `--no-zap`)  |

All six run in parallel via `Promise.allSettled`; the script exits with:

- `0` → all critical checks passed
- `1` → at least one critical check failed (details logged; `logs/preflight-report.json` written)

### 19.2 Decision log — reading & filtering

```bash
# Fetch last 20 planner decisions over HTTP
curl -H "Authorization: Bearer $API_SECRET" \
     "http://localhost:3000/agent-decisions?agentName=planner&limit=20"

# Or directly from disk (tail)
node -e "console.log(JSON.parse(require('fs').readFileSync('logs/agent-decisions.json','utf8')).slice(0,5))"
```

Each entry is safe to share — **never contains credentials**; inputs are reduced to `{ storyKey, title, wordCount }` before being logged.

### 19.3 Failure report artefact (CI)

When a critical step fails, the runner writes two sibling files:

- `logs/pipeline-failure-report.json` — machine-readable full runner result
- `logs/pipeline-failure-report.md`   — human-readable markdown, rendered by [`.github/workflows/qa.yml`](.github/workflows/qa.yml) into the GitHub Actions **Step Summary** via `cat >> $GITHUB_STEP_SUMMARY`

Markdown template:

```markdown
## ❌ Pipeline halted at step `generateSpecs`

**Error class:** `PreconditionError`  
**Code:** `PRECONDITION_FAILED`  
**Recovery hint:** Re-run `scripts/run-story.js` to create Zephyr test cases
for `ISSUE_KEY=SCRUM-5`, then re-trigger the pipeline.

| Step              | Outcome   | Duration |
|-------------------|-----------|----------|
| preFlight         | ✅ passed | 612 ms   |
| fetchStory        | ✅ passed | 1 128 ms |
| generateSpecs     | ❌ failed | 842 ms   |
| executeFunctional | ⏭ skipped| —        |
```

---

## 20. Operational Runbook

Production-readiness concerns (security, resilience, observability, hygiene). Each subsection documents the runtime primitive, the env knobs, and the incident playbook.

### 20.1 Artifact retention

- **Policy:** all `test-results/`, `playwright-report/`, `allure-*`, `custom-report/`, `screenshots/`, `heal-artifacts/` files older than `ARTIFACT_RETENTION_DAYS` (default **30**) are deleted by [`scripts/cleanup-artifacts.js`](scripts/cleanup-artifacts.js).
- **Scheduling:** the `artifact-cleanup` GH Actions job in [`.github/workflows/qa.yml`](.github/workflows/qa.yml) runs nightly (`cron: '0 2 * * *'`).
- **Local usage:** `npm run cleanup:dry-run` (safe preview) → `npm run cleanup:artifacts` (live) → `npm run cleanup:artifacts:aggressive` (half retention).
- **Safety:** `.gitkeep` files and the entire `logs/` tree are never touched. Every run appends a summary to `logs/cleanup-report.json` (rolling last 100 entries).

### 20.2 Scaling considerations

- **Single-pipeline-per-host.** Concurrency is enforced by a filesystem lock at `logs/.pipeline.lock` (`src/utils/pipelineLock.js`). If you need horizontal scaling, externalise the lock to Redis (`SET NX PX`) or replace with a queue (BullMQ, SQS, etc.) keyed on `PROJECT_KEY`.
- **Webhook hardening.** `/api/webhook/jira` is HMAC-signed (`WEBHOOK_SECRET`) and rate-limited by the global API limiter (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`, default 100/min). Rate-limit state is in-memory; horizontal scale requires a shared store.
- **Playwright memory.** Default 50 MB stdout buffer (`PLAYWRIGHT_MAX_BUFFER_MB`). For long soak suites, set `PLAYWRIGHT_STREAM_OUTPUT=true` to stream output to `logs/playwright-<ts>.log` with bounded RAM.
- **Secrets at scale.** Switch `SECRETS_PROVIDER` from `env` to `vault` to pull credentials from HashiCorp Vault on startup; `logs/secret-access.log` records every key access (key + provider + resolvedLength, never the value).

### 20.3 Secret rotation

1. Update the secret in your provider (Vault KV path set via `VAULT_SECRET_PATH`, default `secret/data/agentic-qa`; or `.env` when `SECRETS_PROVIDER=env`).
2. Restart the API server (`npm run start:server`) — `initConfig()` re-reads secrets on boot.
3. In-flight pipelines finish with the previous secret (they read `process.env` / cache at start); new triggers use the rotated value.
4. Verify `logs/secret-access.log` shows a post-restart access entry with the new `resolvedLength`.

### 20.4 Monitoring checklist

| Signal                                                            | Where                                             | Action                                                                  |
|-------------------------------------------------------------------|---------------------------------------------------|-------------------------------------------------------------------------|
| `auth-failure` log lines in `logs/app.log`                        | Winston                                           | Check client configs / possible credential leak; rotate `API_SECRET`.   |
| `rate-limited` log lines                                          | Winston                                           | Raise `RATE_LIMIT_MAX` or investigate caller.                           |
| `Pipeline already running` 409 from `/webhook/manual`             | HTTP response                                     | Expected under load; inspect `logs/.pipeline.lock` for incumbent pid.   |
| `BUFFER_OVERFLOW` error class in `logs/pipeline-failure-report.*` | Failure report                                    | Raise `PLAYWRIGHT_MAX_BUFFER_MB` or enable streaming mode.              |
| `logs/secret-access.log` growing unexpectedly                     | Filesystem                                        | Audit for unintended callers of `getSecret()`.                          |
| `logs/cleanup-report.json` with `removedFiles: 0` for > 7 days    | Filesystem                                        | Verify the nightly GH Actions `artifact-cleanup` job is running.        |
| Size > 20 MB on `logs/app.log` or `logs/error.log`                | Filesystem                                        | Winston rotates at `LOG_MAX_SIZE_BYTES`; rotated copies auto-pruned.    |

---

_© Agentic QA Platform — rule-based agents, pluggable pillars, self-healing by design._
