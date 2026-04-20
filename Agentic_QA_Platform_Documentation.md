# Agentic QA Platform — Complete Documentation

> **Version:** 1.1.0 &nbsp;|&nbsp; **Last Updated:** April 20, 2026 &nbsp;|&nbsp; **Platform:** Node.js 20+ &nbsp;|&nbsp; **Framework:** Playwright

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [System Architecture Diagram](#3-system-architecture-diagram)
4. [Project Structure](#4-project-structure)
5. [AI Agent Pipeline](#5-ai-agent-pipeline)
6. [Pipeline Scripts](#6-pipeline-scripts)
7. [Test Framework](#7-test-framework)
8. [Page Object Model (POM)](#8-page-object-model-pom)
9. [Fixture System](#9-fixture-system)
10. [Self-Healing Agent](#10-self-healing-agent)
11. [Git Agent](#11-git-agent)
12. [Reporting](#12-reporting)
13. [External Integrations](#13-external-integrations)
14. [REST API & Dashboard](#14-rest-api--dashboard)
15. [CI/CD — GitHub Actions](#15-cicd--github-actions)
16. [Configuration Reference](#16-configuration-reference)
17. [npm Scripts Reference](#17-npm-scripts-reference)
18. [Quick Start Guide](#18-quick-start-guide)
19. [Troubleshooting](#19-troubleshooting)

---

## 1. Executive Summary

The **Agentic QA Platform** is an enterprise-grade, fully autonomous Quality Assurance system that eliminates manual test creation, execution, and reporting. It reads a Jira user story and — with zero human input — generates test cases using six software testing design techniques, creates them in Zephyr Scale, generates Playwright test scripts with Page Object Model, executes them, self-heals failing tests, creates Jira bug tickets for remaining failures, generates two types of reports (Custom HTML, Allure), and auto-commits + pushes all artifacts to Git.

### Key Capabilities

| Capability | Technology |
|---|---|
| Test Framework | Playwright + Page Object Model (POM) |
| Test Management | Zephyr Scale (Jira Cloud) — Essential Cloud API v2.8 |
| Issue Tracking | Jira REST API v3 (Atlassian Cloud) |
| AI Agents | Rule-based agents (no external LLM dependency) — Planner, QA, Reviewer, Executor, Risk Prioritizer |
| Self-Healing | Automated failure classification + spec patching + re-verification |
| Reporting | Custom HTML + Allure |
| CI/CD | GitHub Actions (full pipeline on push to `main`) |
| Version Control | Git Agent — auto-commit + push all pipeline artifacts |
| Dashboard API | Express.js REST API (port 3000) + React frontend |
| Application Under Test | OrangeHRM (open-source HR management system) |

### Design Techniques Applied

The platform applies **six industry-standard test design techniques** to every user story:

| Abbreviation | Technique | Purpose |
|---|---|---|
| **BVA** | Boundary Value Analysis | Tests at exact boundary limits (min, max, min±1, max±1) |
| **EP** | Equivalence Partitioning | Divides inputs into valid/invalid partitions |
| **DT** | Decision Table | Tests all input condition combinations |
| **ST** | State Transition | Tests valid/invalid state change paths |
| **EG** | Error Guessing | Tests experience-based edge cases (special chars, duplicates, unicode) |
| **UC** | Use Case | Tests end-to-end user workflow scenarios |

---

## 2. Architecture Overview

The platform is built on a **multi-agent orchestration** architecture with five specialized AI agents that process a Jira story through a sequential pipeline. Each agent has a single responsibility and passes its output to the next.

### High-Level Flow

```
Jira User Story
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│                    AGENT PIPELINE                            │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Planner  │─▶│    QA    │─▶│ Reviewer │─▶│    Risk    │  │
│  │  Agent   │  │  Agent   │  │  Agent   │  │ Prioritizer│  │
│  └──────────┘  └──────────┘  └──────────┘  └─────┬──────┘  │
│                                                    │         │
│  ┌──────────┐                                      │         │
│  │ Executor │◀─────────────────────────────────────┘         │
│  │  Agent   │                                                │
│  └──────────┘                                                │
└──────────────────────────────┬───────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                 ▼
      ┌──────────────┐ ┌──────────────┐  ┌──────────────┐
      │ Zephyr Scale │ │  Playwright  │  │ Git Repo     │
      │ Test Cases   │ │  Spec Files  │  │ (.spec.js)   │
      └──────┬───────┘ └──────┬───────┘  └──────────────┘
             │                 │
             ▼                 ▼
┌─────────────────────────────────────────────────────────────┐
│                   EXECUTION ENGINE                           │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Playwright + ScreenshotHelper                     │   │
│  │  (base.fixture.js — POM + Screenshot + Hooks)        │   │
│  └──────────────────────────┬───────────────────────────┘   │
│                              │                               │
│  ┌──────────────┐    ┌──────┴───────┐    ┌──────────────┐  │
│  │  Self-Healer │    │ Zephyr Sync  │    │  Bug Creator │  │
│  │  (repair +   │    │ (cycle +     │    │  (Jira bugs  │  │
│  │   re-run)    │    │  executions) │    │   + links)   │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
└──────────────────────────────┬───────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                 ▼
      ┌──────────────┐ ┌──────────────┐
      │ Custom HTML  │ │ Allure HTML  │
      │   Report     │ │   Report     │
      └──────────────┘ └──────────────┘
                               │
                               ▼
                      ┌──────────────┐
                      │  Git Agent   │
                      │ (commit+push)│
                      └──────────────┘
```

---

## 3. System Architecture Diagram

### Component Interaction Diagram

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                                                                  │
│                          AGENTIC QA PLATFORM — Full Architecture                 │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                        EXTERNAL SYSTEMS                                     │ │
│  │                                                                             │ │
│  │  ┌─────────────┐     ┌─────────────────┐
│  │  │  Jira Cloud │     │  Zephyr Scale   │
│  │  │             │     │  Essential      │
│  │  │ • Stories   │     │  Cloud API v2.8 │
│  │  │ • Bugs      │     │ • Test Cases    │
│  │  │ • Links     │     │ • Test Cycles   │
│  │  │ • Webhooks  │     │ • Executions    │
│  │  └──────┬──────┘     └────────┬────────┘
│  │         │                     │
│  └─────────┼─────────────────────┼────────────────────────────────────────┘ │
│            │                     │
│  ┌─────────┼─────────────────────┼────────────────────────────────────────┐ │
│  │         ▼                     ▼
│  │  ┌──────────────────────────────────────────────────────────────────────┐  │ │
│  │  │                       API CLIENT LAYER  (src/tools/)                │  │ │
│  │  │                                                                     │  │ │
│  │  │  jira.client.js  │  jiraBug.client.js  │  zephyr.client.js        │  │ │
│  │  │  zephyrCycle.client.js  │  zephyrExecution.client.js              │  │ │
│  │  │  playwright.generator.js                                           │  │ │
│  │  └──────────────────────────────────┬──────────────────────────────────┘  │ │
│  │                                     │                                     │ │
│  │  ┌──────────────────────────────────┼──────────────────────────────────┐  │ │
│  │  │                    AI AGENT LAYER  (src/agents/)                    │  │ │
│  │  │                                                                     │  │ │
│  │  │  ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐  │  │ │
│  │  │  │  Planner  │ │    QA    │ │ Reviewer │ │   Risk   │ │Executor│  │  │ │
│  │  │  │  Agent    │ │  Agent   │ │  Agent   │ │Prioritize│ │ Agent  │  │  │ │
│  │  │  │           │ │          │ │          │ │   Agent  │ │        │  │  │ │
│  │  │  │ • NLP     │ │ • 11     │ │ • Dedup  │ │ • Multi- │ │• Zephyr│  │  │ │
│  │  │  │   rules   │ │   static │ │   (Leven-│ │   factor │ │  CRUD  │  │  │ │
│  │  │  │ • 12 do-  │ │   templ. │ │   shtein)│ │   risk   │ │• Spec  │  │  │ │
│  │  │  │   main    │ │ • 6 dy-  │ │ • Normal-│ │   scoring│ │  gen   │  │  │ │
│  │  │  │   pattern │ │   namic  │ │   ize    │ │ • Sort   │ │        │  │  │ │
│  │  │  │ • 7 test  │ │   gener- │ │ • Enrich │ │   by risk│ │        │  │  │ │
│  │  │  │   types   │ │   ators  │ │          │ │          │ │        │  │  │ │
│  │  │  │ • 6 tech- │ │ • RBAC   │ │          │ │          │ │        │  │  │ │
│  │  │  │   niques  │ │ • AC-    │ │          │ │          │ │        │  │  │ │
│  │  │  │           │ │   based  │ │          │ │          │ │        │  │  │ │
│  │  │  └───────────┘ └──────────┘ └──────────┘ └──────────┘ └────────┘  │  │ │
│  │  │                                                                     │  │ │
│  │  └─────────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                           │ │
│  │  ┌──────────────────────────────────────────────────────────────────────┐  │ │
│  │  │                  ORCHESTRATION LAYER  (src/orchestrator/)            │  │ │
│  │  │                                                                      │  │ │
│  │  │  agentOrchestrator.js — chains all 5 agents sequentially            │  │ │
│  │  │  finalFlow.js — post-execution: cycles, bugs, coverage, mapping     │  │ │
│  │  └──────────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                           │ │
│  │  ┌──────────────────────────────────────────────────────────────────────┐  │ │
│  │  │                    SERVICE LAYER  (src/services/)                    │  │ │
│  │  │                                                                      │  │ │
│  │  │  bug.service.js  │  cycle.service.js  │  execution.service.js       │  │ │
│  │  │  executionMapping.service.js  │  coverage.service.js                │  │ │
│  │  │  flaky.service.js                                                    │  │ │
│  │  └──────────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                           │ │
│  │  ┌──────────────────────────────────────────────────────────────────────┐  │ │
│  │  │                     TEST EXECUTION LAYER                             │  │ │
│  │  │                                                                      │  │ │
│  │  │  ┌────────────┐  ┌────────────────┐  ┌──────────────────────────┐   │  │ │
│  │  │  │ Playwright │  │ base.fixture.js│  │  tests/specs/            │   │  │ │
│  │  │  │  Engine    │  │ (POM +         │  │  SCRUM-T138..T154.spec.js│   │  │ │
│  │  │  │            │  │  Screenshot    │  │  (17 auto-generated)    │   │  │ │
│  │  │  │            │  │  + Hooks)      │  │                          │   │  │ │
│  │  │  └────────────┘  └────────────────┘  └──────────────────────────┘   │  │ │
│  │  │                                                                      │  │ │
│  │  │  ┌────────────────────────────────────────────────────────────────┐  │  │ │
│  │  │  │  Page Objects:  LoginPage  │  AddEmployeePage  │  EmployeeList│  │  │ │
│  │  │  └────────────────────────────────────────────────────────────────┘  │  │ │
│  │  └──────────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                           │ │
│  │  ┌──────────────────────────────────────────────────────────────────────┐  │ │
│  │  │                    PIPELINE SCRIPTS  (scripts/)                      │  │ │
│  │  │                                                                      │  │ │
│  │  │  qa-run.js  │  run-full-pipeline.js  │  run-story.js               │  │ │
│  │  │  run-story-tests.js  │  run-tagged-tests.js  │  run-and-sync.js    │  │ │
│  │  │  generate-playwright.js │ healer.js │ git-sync.js                  │  │ │
│  │  │  generate-report.js  │  generate-allure-report.js                  │  │ │
│  │  │  create-jira-bugs.js  │  validate-integration.js                   │  │ │
│  │  │  ensure-dirs.js │ diag-zephyr.js │ test-agents.js │ test-endpoints.js│  │ │
│  │  └──────────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                           │ │
│  │  ┌──────────────────────────────────────────────────────────────────────┐  │ │
│  │  │                    REPORTING LAYER                                   │  │ │
│  │  │                                                                      │  │ │
│  │  │  ┌──────────────┐  ┌──────────────┐  │  │ │
│  │  │  │ Custom HTML  │  │ Allure HTML  │  │  │ │
│  │  │  │ (pie chart,  │  │ (drill-down  │  │  │ │
│  │  │  │  screenshots,│  │  interactive │  │  │ │
│  │  │  │  video,      │  │  HTML)       │  │  │ │
│  │  │  │  step tables)│  │              │  │  │ │
│  │  │  └──────────────┘  └──────────────┘  │  │ │
│  │  └──────────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                           │ │
│  │  ┌──────────────────────────────────────────────────────────────────────┐  │ │
│  │  │          REST API + DASHBOARD  (src/api/ + dashboard/)              │  │ │
│  │  │                                                                      │  │ │
│  │  │  Express server (:3000)  │  React dashboard (pass/fail/total)       │  │ │
│  │  │  Jira webhook listener  │  Screenshot browser  │  Manual trigger    │  │ │
│  │  └──────────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                           │ │
│  │  ┌──────────────────────────────────────────────────────────────────────┐  │ │
│  │  │                    CI/CD  (.github/workflows/qa.yml)                 │  │ │
│  │  │                                                                      │  │ │
│  │  │  GitHub Actions → full pipeline (headless) → upload artifacts        │  │ │
│  │  │  → commit generated specs back to main [skip ci]                     │  │ │
│  │  └──────────────────────────────────────────────────────────────────────┘  │ │
│  └───────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow Diagram

```
    ┌─────────────┐
    │  .env file  │ ◄── JIRA_URL, ZEPHYR_ACCESS_KEY, ISSUE_KEY
    └──────┬──────┘
           │
           ▼
    ┌─────────────┐     GET /rest/api/3/issue/{key}         ┌─────────────┐
    │  run-story   │ ──────────────────────────────────────▶ │  Jira Cloud │
    │    .js       │ ◄──────────────────────────────────────  │  (Story)    │
    └──────┬──────┘     { summary, description, AC }         └─────────────┘
           │
           ▼  story object
    ┌──────────────┐
    │   Planner    │ ─▶ { scope, testTypes, designTechniques, risks }
    │   Agent      │
    └──────┬───────┘
           │  plan
           ▼
    ┌──────────────┐
    │   QA Agent   │ ─▶ [ testCase1, testCase2, ... testCaseN ]
    │ (11+6+2      │     Each: { title, steps[], testData[], expected, tags[] }
    │  generators) │
    └──────┬───────┘
           │  raw test cases
           ▼
    ┌──────────────┐
    │  Reviewer    │ ─▶ Deduplicated + normalized test cases
    │  Agent       │     (Levenshtein ≥ 0.85 threshold)
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │    Risk      │ ─▶ Sorted by composite risk score
    │ Prioritizer  │     (40% business + 30% failure + 30% severity)
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐    POST /testcases             ┌─────────────────┐
    │  Executor    │ ─────────────────────────────▶  │  Zephyr Scale   │
    │  Agent       │    + POST /testcases/{}/steps   │  (Test Cases)   │
    └──────┬───────┘                                  └─────────────────┘
           │
           ▼  writes .spec.js files
    ┌──────────────────────────┐
    │  tests/specs/            │
    │  SCRUM-T*.spec.js        │  ◄── Auto-generated POM-based specs
    │  (17 files)              │      using base.fixture.js
    └──────────┬───────────────┘
               │
               ▼  npx playwright test
    ┌──────────────────────────────────────────────────────────┐
    │  PLAYWRIGHT EXECUTION                                     │
    │                                                           │
    │  base.fixture.js provides per-test:                       │
    │   • loginPage, addEmployeePage, employeeListPage (POM)    │
    │   • sh (ScreenshotHelper — auto step screenshots)         │
    │   • uniqueSuffix, _consoleErrors                          │
    │                                                           │
    │  Lifecycle:                                                │
    │   beforeEach → clear cookies (session isolation)           │
    │   afterEach  → capture failure screenshot, log result      │
    │   beforeAll  → log suite start                             │
    │   afterAll   → log suite summary (pass/fail/elapsed)       │
    └──────────┬────────────────────┬───────────────────────────┘
               │                    │
               ▼                    ▼
    ┌──────────────┐
    │ test-results │
    │   .json      │
    │ (Playwright  │
    │  JSON report)│
    └──────┬───────┘
           │
     ┌─────┼──────────┬───────────────┬─────────────────┐
     │     │          │               │                  │
     ▼     ▼          ▼               ▼                  ▼
  ┌──────┐ ┌──────┐ ┌────────┐ ┌───────────┐ ┌──────────────────┐
  │Healer│ │Zephyr│ │Jira Bug│ │  2 Report │ │   Git Agent      │
  │(patch│ │ Sync │ │Creator │ │ Generators│ │  (commit + push)  │
  │+rerun│ │      │ │        │ │           │ │                   │
  │)     │ │      │ │        │ │           │ │                   │
  └──────┘ └──────┘ └────────┘ └───────────┘ └──────────────────┘
```

---

## 4. Project Structure

```
agentic-qa-platform-full/
│
├── src/                              # Backend server + AI agent layer
│   ├── main.js                       #   Express server entry point (port 3000)
│   │
│   ├── agents/                       #   AI Agents (rule-based, no LLM dependency)
│   │   ├── planner.agent.js          #     Story analysis → test plan (NLP heuristics)
│   │   ├── qa.agent.js               #     Test case generation (11 static + 6 dynamic + 2 conditional)
│   │   ├── reviewer.agent.js         #     Deduplication (Levenshtein) + normalization
│   │   ├── riskPrioritizer.agent.js  #     Multi-factor risk scoring + priority sort
│   │   └── executor.agent.js         #     Zephyr TC creation + Playwright spec generation
│   │
│   ├── orchestrator/                 #   Pipeline orchestration
│   │   ├── agentOrchestrator.js      #     Chains all 5 agents: Jira→Plan→Generate→Review→Risk→Execute
│   │   └── finalFlow.js              #     Post-execution: cycles, bugs, coverage, mapping
│   │
│   ├── services/                     #   Business logic services
│   │   ├── bug.service.js            #     Create Jira bugs from test failures
│   │   ├── coverage.service.js       #     Keyword-overlap coverage calculation
│   │   ├── cycle.service.js          #     Zephyr test cycle management
│   │   ├── execution.service.js      #     Spawn Playwright as child process
│   │   ├── executionMapping.service.js#    Map Playwright results → Zephyr executions
│   │   └── flaky.service.js          #     Rolling-window flaky test detection
│   │
│   ├── tools/                        #   External API clients
│   │   ├── jira.client.js            #     GET /rest/api/3/issue/{key}
│   │   ├── jiraBug.client.js         #     POST bug + issue link (ADF description)
│   │   ├── zephyr.client.js          #     CRUD test cases + steps
│   │   ├── zephyrCycle.client.js     #     CRUD test cycles
│   │   ├── zephyrExecution.client.js #     CRUD test executions
│   │   └── playwright.generator.js   #     Stub spec file generator (used by executor agent)
│   │
│   ├── api/                          #   REST API layer
│   │   ├── routes.js                 #     Express Router: /dashboard, /webhook/*, /screenshots/*
│   │   ├── dashboard.controller.js   #     GET /api/dashboard → { total, passed, failed }
│   │   ├── webhook.controller.js     #     Jira webhook receiver (HMAC validation, 5-min cooldown)
│   │   └── screenshot.controller.js  #     Screenshot browser REST endpoints
│   │
│   ├── core/                         #   Core infrastructure
│   │   ├── config.js                 #     Central config from env vars
│   │   └── errorHandler.js           #     AppError class (HTTP status codes)
│   │
│   └── utils/                        #   Shared utilities
│       ├── logger.js                 #     Winston logger (console + file)
│       ├── openai.js                 #     Optional OpenAI wrapper (not used by default agents)
│       ├── resultParser.js           #     Parse test-results.json → flat array
│       ├── retry.js                  #     Generic async retry (3 attempts, 1.5s delay)
│       └── zephyrJwt.js              #     Zephyr API auth headers
│
├── tests/                            # Playwright test framework
│   ├── global-setup.js               #   Dir init + AUT health-check + auth cache + cleanup
│   ├── global-teardown.js            #   Suite summary + Allure results validation
│   │
│   ├── fixtures/                     #   Composed Playwright fixtures
│   │   ├── base.fixture.js           #     ★ Master fixture (POM + Screenshot + Hooks)
│   │   └── pom.fixture.js            #     Lightweight POM-only fixture
│   │
│   ├── helpers/                      #   Test helpers
│   │   ├── screenshot.helper.js      #     ScreenshotHelper class (step screenshots)
│   │   └── locatorLoader.js          #     YAML locator file loader for page objects
│   │
│   ├── pages/                        #   Page Object Model
│   │   ├── LoginPage.js              #     goto(), login(), getErrorMessage()
│   │   ├── LoginPage.yml             #     Locator definitions for LoginPage
│   │   ├── AddEmployeePage.js        #     navigate(), fillEmployee(), setEmployeeId(), save(), cancel()
│   │   ├── AddEmployeePage.yml       #     Locator definitions for AddEmployeePage
│   │   ├── EmployeeListPage.js       #     navigate(), searchEmployee(), getRowCount()
│   │   └── EmployeeListPage.yml      #     Locator definitions for EmployeeListPage
│   │
│   ├── data/                         #   Test data
│   │   └── testData.js               #     BASE_URL, CREDENTIALS, TEST_EMPLOYEE, ROUTES
│   │
│   ├── features/                     #   BDD feature files (Gherkin)
│   │   └── login/
│   │       └── login.feature         #     Login scenarios in Gherkin format
│   │
│   ├── healed/                       #   Auto-generated healed spec copies (self-healer output)
│   │
│   └── specs/                        #   Auto-generated spec files (17 tests)
│       ├── SCRUM-T138_verify_duplicate_employee_creation_*.spec.js
│       ├── SCRUM-T139_verify_session_timeout_*.spec.js
│       ├── SCRUM-T140_verify_concurrent_access_*.spec.js
│       └── ... (17 total: SCRUM-T138 through SCRUM-T154)
│
├── scripts/                          # CLI pipeline scripts
│   ├── qa-run.js                     #   ★ Main 8-stage pipeline (zero-prompt)
│   ├── run-full-pipeline.js          #   ★ Full autonomous 8-stage journey
│   ├── run-story.js                  #     Fetch story → create Zephyr TCs (7 steps)
│   ├── run-story-tests.js            #     Story-specific execution (6 stages)
│   ├── run-tagged-tests.js           #     Tag-filtered execution (5 stages)
│   ├── run-and-sync.js               #     Run Playwright + sync Zephyr (6 steps)
│   ├── generate-playwright.js        #     Zephyr TCs → .spec.js files (12 templates)
│   ├── generate-report.js            #     Custom HTML report generator
│   ├── generate-allure-report.js     #     Allure HTML report generator
│   ├── create-jira-bugs.js           #     Auto-create Jira bugs + link to story
│   ├── healer.js                     #     Self-healing agent (classify + patch + re-run)
│   ├── git-sync.js                   #     Git agent (add + commit + push)
│   ├── validate-integration.js       #     API connectivity validation (Jira + Zephyr)
│   ├── ensure-dirs.js                #     Output directory management (create + clean)
│   ├── diag-zephyr.js                #     Zephyr sync diagnostic tool
│   ├── test-agents.js                #     Agent smoke tests (mock story, no API calls)
│   └── test-endpoints.js             #     REST API endpoint tests
│
├── dashboard/                        # React dashboard (separate package)
│   ├── package.json                  #   react: ^18.2.0
│   └── src/App.js                    #   Minimal pass/fail/total display
│
├── .github/workflows/qa.yml         # GitHub Actions CI pipeline
├── playwright.config.js              # Playwright config (90s timeout, 1 retry, 4 reporters)
├── .env.example                      # Environment variable template
├── .eslintrc.json                    # ESLint rules
├── .gitignore                        # Git ignore rules
└── package.json                      # Dependencies + npm scripts
```

---

## 5. AI Agent Pipeline

### 5.1 Planner Agent (`src/agents/planner.agent.js`)

**Purpose:** Analyses a Jira user story and produces a structured test plan without any external LLM calls — pure rule-based NLP.

**How it works:**

1. **Text Extraction** — Recursively extracts plain text from Jira's Atlassian Document Format (ADF) nodes
2. **Test Type Detection** — Scans story text against `TYPE_SIGNALS` (7 types: functional, security, UI, performance, integration, boundary, negative) — each with weighted keyword patterns
3. **Design Technique Selection** — Maps detected types to applicable design techniques (`TECHNIQUE_SIGNALS`: BVA, EP, DT, ST, EG, UC)
4. **Risk Identification** — Scans for `RISK_SIGNALS` (9 risk keywords: authentication, data loss, permission, injection, timeout, concurrent, etc.)
5. **Scenario Augmentation** — Applies `SCENARIO_PATTERNS` (12 domain-specific regex patterns for login, CRUD, upload, RBAC, search, reports, etc.) to inject domain-specific critical scenarios

**Output:**
```json
{
  "scope": "Extracted story text...",
  "testTypes": ["functional", "security", "ui"],
  "designTechniques": ["BVA", "EP", "DT", "ST", "EG", "UC"],
  "criticalScenarios": ["Valid login with correct credentials", ...],
  "risks": ["Authentication failure may expose session tokens", ...]
}
```

### 5.2 QA Agent (`src/agents/qa.agent.js`)

**Purpose:** The core test case generator. Produces detailed, ready-to-execute test cases from a Jira story and planner output.

**Generation Strategy:**

| Category | Count | Examples |
|---|---|---|
| Static templates | 11 | Happy path (EP-Valid), Mandatory fields (EP-Empty), Invalid input (EP-Invalid + EG), Boundary values (BVA), Duplicate entry (EG), Special chars/unicode (EG), UI feedback (UC), Cancel/discard (ST), Data persistence (ST), Max records (BVA-Volume), extra persistence |
| Dynamic generators | 6 | Session timeout, Concurrency, Accessibility, Browser back/forward, Network resilience, Clipboard/paste |
| Conditional | 2 | RBAC/security (if security keywords detected), Acceptance criteria (if AC field present) |
| **Total potential** | **19** | — |

**Each test case includes:**
- `title` — Human-readable test case name
- `description` — Detailed description
- `designTechnique` — Which design technique (BVA/EP/DT/ST/EG/UC)
- `steps[]` — Ordered step instructions
- `testData[]` — Concrete test data values
- `gwt[]` — Given/When/Then format (auto-converted by `stepsToGWT()`)
- `expected` — Expected result
- `priority` — High / Normal / Low
- `tags[]` — Searchable tags

### 5.3 Reviewer Agent (`src/agents/reviewer.agent.js`)

**Purpose:** Post-generation quality gate.

**Operations:**
1. **Deduplication** — Compares all test case title pairs using Levenshtein edit distance. Removes duplicates where similarity ≥ 0.85 (85%)
2. **Normalization** — Ensures each test case has:
   - At least 3 steps (adds placeholder steps if missing)
   - Non-empty `expected` field
   - Valid priority (High / Normal / Low)
   - Tags as lowercase string array

### 5.4 Risk Prioritizer Agent (`src/agents/riskPrioritizer.agent.js`)

**Purpose:** Multi-factor risk-based test prioritization to ensure highest-risk tests run first.

**Scoring Dimensions:**

| Dimension | Weight | Score Range | Signal Source |
|---|---|---|---|
| Business Impact | 40% | 1–10 | Tag-to-score map (`BUSINESS_IMPACT_MAP`) |
| Failure Likelihood | 30% | 1–10 | Tag-to-score map (`FAILURE_LIKELIHOOD_MAP`) |
| Defect Severity | 30% | 1–10 | Tag-to-score map (`SEVERITY_MAP`) |

**Context Boosters:** 6 regex-based patterns (login, payment, delete, admin, upload, employee) add +1–2 to scores when story text matches.

**Formula:** `compositeRisk = (0.4 × business) + (0.3 × failure) + (0.3 × severity)`

**Output:** Tests sorted highest-risk-first, with re-assigned priority labels:
- `compositeRisk >= 7` → **High**
- `compositeRisk >= 4` → **Normal**
- `compositeRisk < 4` → **Low**

### 5.5 Executor Agent (`src/agents/executor.agent.js`)

**Purpose:** Creates test cases in Zephyr Scale and generates Playwright spec files.

**Operations:**
1. **Zephyr CRUD** — Calls `createTestCase()` for each test case (with steps in GWT format)
2. **Spec Generation** — Calls `generateTest()` to create a `.spec.js` file per test case

### 5.6 Orchestrator (`src/orchestrator/agentOrchestrator.js`)

Chains all 5 agents in sequence:

```
runAgentFlow(issueKey)
  │
  ├── 1. jira.getStory(issueKey)        → story
  ├── 2. planner.plan(story)             → plan
  ├── 3. qa.generate(story, plan)        → rawTestCases
  ├── 4. reviewer.review(rawTestCases)   → cleanTestCases
  ├── 5. riskPrioritizer.prioritize()    → sortedTestCases
  └── 6. executor.execute(sortedTestCases) → { createdKeys }
```

---

## 6. Pipeline Scripts

### 6.1 Main Pipeline: `qa-run.js` (8 Stages)

The primary single-command pipeline. Runs all 8 stages sequentially with zero human input.

```
┌─────────────────────────────────────────────────────────────────────┐
│  qa-run.js — Single-Command End-to-End Pipeline (8 stages)         │
│                                                                     │
│  Stage 1  Fetch Jira story → create detailed Zephyr test cases      │
│           (BVA, EP, DT, ST, EG, UC + concrete test data)            │
│                                                                     │
│  Stage 2  Generate Playwright spec files from Zephyr                │
│                                                                     │
│  Stage 3  Run Playwright tests                                      │
│           → Sync Pass/Fail results to Zephyr                        │
│                                                                     │
│  Stage 4  Self-Healing Agent → repair & re-run failing tests        │
│                                                                     │
│  Stage 5  Auto-Create Jira Bugs for remaining failures              │
│                                                                     │
│  Stage 6  Generate custom HTML report with screenshots              │
│                                                                     │
│  Stage 7  Generate Allure report (interactive drill-down)           │
│                                                                     │
│  Stage 8  Git Agent — auto-commit + push all changes                │
└─────────────────────────────────────────────────────────────────────┘
```

**Flags:**

| Flag | Effect |
|---|---|
| `--skip-story` | Skip stage 1 (use existing Zephyr TCs) |
| `--skip-generate` | Skip stages 1+2 |
| `--run-only` | Stages 3–8 only |
| `--force` | Force-recreate Zephyr test cases |
| `--skip-heal` | Skip stage 4 (healer) |
| `--skip-bugs` | Skip stage 5 (bug creation) |
| `--skip-git` | Skip stage 8 (git push) |
| `--headless` | Run browser in headless CI mode |

### 6.2 Full Pipeline: `run-full-pipeline.js` (8 Stages)

Same 8 stages as `qa-run.js` but with different presentation (purple-themed banner, journey-style output). Used as the `npm start` command.

### 6.3 Story Test Runner: `run-story-tests.js` (6 Stages)

Runs only spec files belonging to a specific Jira story. Resolves specs via `.story-testcases.json` handoff file or Zephyr label search.

| Stage | Description |
|---|---|
| 0 (optional) | Re-generate spec files (`--regen-specs`) |
| 1 | Execute story specs → sync Zephyr |
| 2 | Self-Healing Agent |
| 3 | Auto-create Jira bugs |
| 4 | Generate HTML report |
| 5 | Generate Allure report |
| 6 | Git Agent → commit + push |

### 6.4 Tagged Test Runner: `run-tagged-tests.js` (5 Stages)

Runs tests filtered by tag/annotation pattern with a rich alias system.

| Stage | Description |
|---|---|
| 1 | Run filtered tests |
| 2 | Self-Healing Agent |
| 3 | Generate HTML report |
| 4 | Generate Allure report |
| 5 | Git Agent → commit + push |

**Built-in Tag Aliases:**

| Tag | Matches |
|---|---|
| `smoke` | Happy-path / valid input tests |
| `regression` | All tests |
| `bva` | Boundary value analysis tests |
| `ep` | Equivalence partitioning tests |
| `negative` | Invalid input / mandatory field tests |
| `boundary` | Boundary / edge-case tests |
| `security` / `rbac` | Role-based access control tests |
| `unicode` | Special character tests |
| `ui` | UI feedback tests |
| `cancel` | Cancel / discard tests |
| `persistence` | Data persistence tests |
| `duplicate` | Duplicate entry tests |
| `max` | Maximum record count tests |
| `SCRUM-T36` | Exact Zephyr key |
| `<any regex>` | Passed directly as Playwright `--grep` |

### 6.5 Supporting Scripts

| Script | Purpose |
|---|---|
| `run-story.js` | Fetch Jira story → agent pipeline → create Zephyr TCs (7 steps) |
| `run-and-sync.js` | Run Playwright + create Zephyr cycle + sync executions (6 steps) |
| `generate-playwright.js` | Zephyr TCs → POM-based `.spec.js` files (12 type-specific templates) |
| `healer.js` | Self-healing agent — classify failures, patch specs, re-run |
| `git-sync.js` | Git agent — `git add -A` → commit → push |
| `generate-report.js` | Custom HTML report with pie chart, screenshots, video |
| `generate-allure-report.js` | Allure CLI: `allure generate allure-results/ -o allure-report/` |
| `create-jira-bugs.js` | Create Jira bugs for failures + link to parent story |
| `validate-integration.js` | Test Jira + Zephyr API connectivity |
| `ensure-dirs.js` | Guarantee all output directories exist; wipe stale contents pre-run |
| `diag-zephyr.js` | Diagnostic tool — parse `test-results.json` and check Zephyr sync status |
| `test-agents.js` | Smoke-test all AI agents using a mock Jira story (no external API calls) |
| `test-endpoints.js` | Quick health-check for REST API endpoints (requires server running on `:3000`) |

---

## 7. Test Framework

### 7.1 Playwright Configuration

| Setting | Value |
|---|---|
| Test directory | `./tests/specs` |
| Timeout | 90,000ms (90 seconds) |
| Retries | 1 |
| Workers | 3 by default (parallel); override with `PW_WORKERS` env var |
| Fully parallel | `true` — tests run concurrently across workers |
| Base URL | `https://opensource-demo.orangehrmlive.com` |
| Browser | Chromium |
| Headed/Headless | Headed by default; `PW_HEADLESS=true` or `--headless` flag for CI |
| Slow motion | 50ms (headed), 0ms (headless) |
| Screenshots | On failure only (ScreenshotHelper captures per-step screenshots) |
| Video | Retained on failure |
| Trace | Retained on failure |
| Test grep filter | `PW_GREP=<regex>` env var (e.g. `PW_GREP=SCRUM-T138`) |

### 7.2 Reporters

| Reporter | Output |
|---|---|
| `list` | Console output |
| `json` | `test-results.json` |
| `html` | `playwright-report/index.html` |
| `allure-playwright` | `allure-results/` (for Allure CLI) |

### 7.3 Global Setup (`tests/global-setup.js`)

Runs once before the entire test suite:
1. **Directory Initialization** — Calls `ensureDirs()` (from `scripts/ensure-dirs.js`) to guarantee every output directory exists (`allure-results/`, `allure-report/`, `test-results/screenshots/`, `custom-report/`, `playwright-report/`, `.auth/`)
2. **Cleanup** — Wipes `allure-results/` and `test-results/screenshots/` using `cleanDir()` so reports reflect only the current run
3. **Health Check** — Launches headless Chromium, navigates to OrangeHRM login page, asserts HTTP 200 and that `input[name="username"]` renders. **Fails fast** if the application under test is unreachable
4. **Auth Cache** — Logs in as Admin, saves `storageState` to `.auth/storage-state.json`
5. **Logging** — Prints base URL, worker count, retries, and timestamp

### 7.4 Global Teardown (`tests/global-teardown.js`)

Runs once after the entire test suite:
1. **Result Parsing** — Walks `test-results.json` suite tree counting passed/failed/skipped/flaky
2. **Summary Table** — Prints total, pass/fail/skip/flaky counts, duration, and pass rate
3. **Allure Validation** — Calls `validateAllureResults()` (from `scripts/ensure-dirs.js`) to verify `allure-results/` contains result files, warning if the directory is empty

---

## 8. Page Object Model (POM)

All page objects follow a consistent pattern with **YAML-based external locator files**. Locators are loaded at construction time via `tests/helpers/locatorLoader.js`, which parses `<PageName>.yml` files next to each page class. This decouples selector maintenance from test logic — updating a locator never requires changing test code.

### 8.0 Locator Loader (`tests/helpers/locatorLoader.js`)

Reads a `.yml` file of `key: selector` pairs and returns a plain object. Supports single-quoted, double-quoted, and unquoted values; ignores comments and blank lines.

```js
// Usage inside a page object
const { loadLocators } = require('../helpers/locatorLoader');
const loc = loadLocators(path.join(__dirname, 'LoginPage.yml'));
// loc.usernameInput → 'input[name="username"]'
```

### 8.1 LoginPage (`tests/pages/LoginPage.js`)

| Method | Description |
|---|---|
| `goto()` | Navigate to `/web/index.php/auth/login`, wait for username input |
| `login(username, password)` | Full login flow: goto → fill username → fill password → click login → wait for dashboard URL |
| `getErrorMessage()` | Returns visible error alert text, or `null` |

**Locators:** `usernameInput`, `passwordInput`, `loginButton`, `errorAlert`  
**YAML file:** `tests/pages/LoginPage.yml`

### 8.2 AddEmployeePage (`tests/pages/AddEmployeePage.js`)

| Method | Description |
|---|---|
| `navigate()` | Go to `/web/index.php/pim/addEmployee`, wait for first name input |
| `fillEmployee({ firstName, middleName?, lastName })` | Fill the name fields |
| `setEmployeeId(id)` | Overwrite the auto-generated Employee ID |
| `save()` | Click the Save button |
| `cancel()` | Click Cancel if visible, otherwise navigate to Employee List |

**Locators:** `firstNameInput`, `middleNameInput`, `lastNameInput`, `employeeIdInput`, `saveButton`, `cancelButton`, `validationErrors`  
**YAML file:** `tests/pages/AddEmployeePage.yml`

### 8.3 EmployeeListPage (`tests/pages/EmployeeListPage.js`)

| Method | Description |
|---|---|
| `navigate()` | Go to `/web/index.php/pim/viewEmployeeList`, wait for DOM |
| `searchEmployee(name)` | Type name with typing delay, click search, wait for DOM |
| `getRowCount()` | Returns count of visible table rows |

**Locators:** `searchNameInput`, `searchButton`, `tableRows`, `noRecordsText`, `paginationInfo`  
**YAML file:** `tests/pages/EmployeeListPage.yml`

---

## 9. Fixture System

The platform uses Playwright's **composed fixture** pattern with two tiers:

### 9.1 Master Fixture: `base.fixture.js` ★

Used by all auto-generated spec files. Provides everything needed for test execution.

| Fixture | Type | Description |
|---|---|---|
| `loginPage` | POM | `LoginPage` instance bound to the page |
| `addEmployeePage` | POM | `AddEmployeePage` instance bound to the page |
| `employeeListPage` | POM | `EmployeeListPage` instance bound to the page |
| `uniqueSuffix` | Data | 5-digit timestamp string for unique test data |
| `sh` | Screenshot | `ScreenshotHelper` with auto step screenshots |
| `_consoleErrors` | Diagnostics | Collects `console.error` messages, attaches on failure |

**Automatic Lifecycle Hooks:**

| Hook | Scope | Behavior |
|---|---|---|
| `_beforeEach` | Per test | Clears cookies for session isolation |
| `_afterEach` | Per test | On failure: captures screenshot, dismisses dialogs. Always: logs test result (✅/❌) |
| `_beforeAll` | Per worker | Logs suite start time, resets counters |
| `_afterAll` | Per worker | Logs suite summary with pass/fail counts and elapsed time |

### 9.2 POM-Only Fixture: `pom.fixture.js`

Lightweight alternative when screenshots are not needed. Provides only POM fixtures + `uniqueSuffix`.

### 9.3 ScreenshotHelper (`tests/helpers/screenshot.helper.js`)

| Method | Purpose |
|---|---|
| `step(label, fn)` | Wraps function in `test.step()`, captures screenshot after completion |
| `capture(label)` | Standalone screenshot capture |

Screenshots are saved as `step-01-label.png`, `step-02-label.png`, etc. in `test-results/screenshots/<test-slug>/` and embedded in the custom HTML report.

---

## 10. Self-Healing Agent

**Script:** `scripts/healer.js`

The self-healing agent automatically detects, classifies, and repairs failing tests.

### Workflow

```
Stage 0  Execute full test suite (optional — --skip-run to reuse existing results)
   │
   ▼
Stage 1  Analyse failures — parse test-results.json
   │
   ▼
Stage 2  Apply healing patches per failure strategy
   │
   ▼
Stage 3  Re-run ONLY healed specs (from tests/healed/) to verify fixes
   │
   ▼
Stage 4  Summary — save test-results-healed.json
```

### Healing Strategies

| Strategy | Error Pattern | Patch Applied |
|---|---|---|
| `timeout` | Test/action timed out | Extend timeouts + add `waitUntil: 'networkidle'` |
| `strict_mode` | Strict mode violation / multiple elements | Add `.first()` to locator chains |
| `not_visible` | Element not visible / hidden | Add visibility guard (`waitFor({ state: 'visible' })`) |
| `navigation` | Navigation failed / page not loaded | Add `waitUntil: 'domcontentloaded'` + `networkidle` |
| `selector` | Element not found / selector mismatch | Extend `waitForURL` timeout |
| `general` | Unclassified errors | Apply safe defaults (extended timeouts + visibility checks) |

---

## 11. Git Agent

**Script:** `scripts/git-sync.js`

Automatically stages, commits, and pushes all pipeline artifacts to the current Git branch.

### Behavior

1. Verifies the workspace is a Git repository (skips cleanly if not)
2. `git add -A` — stages all modified/new files (specs, results, reports, screenshots)
3. Checks if working tree is clean — skips if nothing to commit
4. Commits with auto-generated message:
   ```
   chore(qa-pipeline): auto-run SCRUM-6 — 15/17 passed — 2026-04-08 12:34:56
   ```
5. Pushes to `origin/<current-branch>`
6. **softFail** — push failures exit 0 (non-fatal to pipeline)

### Flags

| Flag | Effect |
|---|---|
| `--skip-push` | Commit only, do not push |
| `--dry-run` | Show what would be committed without making changes |

---

## 12. Reporting

The platform generates **two independent reports** after every pipeline run.

### 12.1 Custom HTML Report

**Script:** `scripts/generate-report.js`  
**Output:** `custom-report/index.html`

Features:
- Summary dashboard with pass/fail/blocked counts and pie chart
- Per-test collapsible accordion cards (green = pass, red = fail)
- Step-by-step table with duration and pass/fail badges
- Failure step highlighted in red with inline error message
- Playwright-captured failure screenshots embedded as base64
- Video recordings embedded as `<video>` elements (WebM)
- Step screenshots from ScreenshotHelper inline in step table
- Link to Allure report

### 12.2 Allure Report

**Script:** `scripts/generate-allure-report.js`  
**Output:** `allure-report/index.html`

Uses `allure-commandline` to generate an interactive Allure HTML report from `allure-results/` directory. Features drill-down views, timeline, severity breakdown, and test history.

---

## 13. External Integrations

### 13.1 Jira (Atlassian Cloud)

| Operation | API | Client File |
|---|---|---|
| Fetch story | `GET /rest/api/3/issue/{key}` | `jira.client.js` |
| Create bug | `POST /rest/api/3/issue` (ADF body) | `jiraBug.client.js` |
| Link bug to story | `POST /rest/api/3/issueLink` | `jiraBug.client.js` |
| Attach screenshots | `POST /rest/api/3/issue/{key}/attachments` | `create-jira-bugs.js` |

### 13.2 Zephyr Scale (Essential Cloud API v2.8)

| Operation | API | Client File |
|---|---|---|
| Create test case | `POST /testcases` | `zephyr.client.js` |
| Add test steps | `POST /testcases/{key}/teststeps` | `zephyr.client.js` |
| CRUD test cases | `GET/PUT/DELETE /testcases/{key}` | `zephyr.client.js` |
| Create test cycle | `POST /testcycles` | `zephyrCycle.client.js` |
| Create execution | `POST /testexecutions` | `zephyrExecution.client.js` |
| Update execution | `PUT /testexecutions/{id}` | `zephyrExecution.client.js` |
| Mark as Automated | `PUT /testcases/{key}` | `run-and-sync.js` |

**Status Mapping:**

| Playwright Status | Zephyr Status |
|---|---|
| `passed` | `Pass` |
| `failed` | `Fail` |
| `timedOut` | `Blocked` |
| `skipped` | `Not Executed` |

---

## 14. REST API & Dashboard

### 14.1 Express Server (`src/main.js`)

Starts on port 3000 (configurable via `PORT` env var).

**Startup Validation:**
- Requires `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` — exits with error if missing

### 14.2 API Endpoints

| Method | Path | Description | Authentication |
|---|---|---|---|
| `GET` | `/api/dashboard` | Test results summary: `{ total, passed, failed }` | Optional (`API_SECRET`) |
| `POST` | `/api/webhook/jira` | Jira webhook receiver (HMAC-SHA256 validated) | HMAC signature |
| `POST` | `/api/webhook/manual` | Manual pipeline trigger | Bearer token |
| `GET` | `/api/webhook/status` | Webhook processing status | Bearer token |
| `GET` | `/api/screenshots` | List all test screenshots | Optional |
| `GET` | `/api/screenshots/summary` | Aggregated screenshot stats | Optional |
| `GET` | `/api/screenshots/:testId` | Screenshots for a specific test | Optional |
| `GET` | `/api/screenshots/:testId/:filename` | Serve individual screenshot file | Optional |

### 14.3 Webhook Integration

The platform can auto-trigger the full pipeline when:
- A Jira issue is **created** or **updated** with a status in `WEBHOOK_TRIGGER_STATUSES`
- A Jira **comment** containing `/qa-run` is added to an issue

**Security:**
- HMAC-SHA256 signature validation (`WEBHOOK_SECRET`)
- 5-minute cooldown per issue (prevents duplicate triggers)
- Bearer token authentication on manual trigger endpoint

### 14.4 React Dashboard (`dashboard/`)

Minimal React 18 app showing `Total`, `Passed`, `Failed` counts from `/api/dashboard`.

---

## 15. CI/CD — GitHub Actions

**Workflow file:** `.github/workflows/qa.yml`

**Triggers:** Push to `main` + manual `workflow_dispatch`

### Pipeline Steps

| Step | Action |
|---|---|
| 1 | Checkout repository (full history: `fetch-depth: 0`) |
| 2 | Setup Node.js 20 with npm cache |
| 3 | `npm install` |
| 4 | `npx playwright install --with-deps chromium` |
| 5 | Run full pipeline: `node scripts/run-full-pipeline.js --headless` |
| 6 | Upload artifact: `playwright-report/` (30-day retention) |
| 7 | Upload artifact: `custom-report/` (30-day retention) |
| 8 | Upload artifact: `allure-results/` (30-day retention) |
| 9 | Upload artifact: `allure-report/` (30-day retention) |
| 10 | Commit and push generated artifacts back to `main` with `[skip ci]` |

**Environment Variables (from GitHub Secrets):**
- `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`
- `ZEPHYR_BASE_URL`, `ZEPHYR_ACCESS_KEY`
- `ISSUE_KEY`, `PROJECT_KEY`
- `PW_HEADLESS=true`

---

## 16. Configuration Reference

### 16.1 Environment Variables (`.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `JIRA_URL` | ✅ | — | Jira Cloud base URL (e.g. `https://org.atlassian.net`) |
| `JIRA_EMAIL` | ✅ | — | Jira account email |
| `JIRA_API_TOKEN` | ✅ | — | Jira API token |
| `PROJECT_KEY` | ✅ | `SCRUM` | Jira/Zephyr project key |
| `ISSUE_KEY` | ✅ | — | Target Jira story key (e.g. `SCRUM-6`) |
| `ZEPHYR_BASE_URL` | ✅ | `https://prod-api.zephyr4jiracloud.com/v2` | Zephyr Essential API base |
| `ZEPHYR_ACCESS_KEY` | ✅ | — | Zephyr API access key |
| `PW_HEADLESS` | Optional | `false` | Run Playwright in headless mode |
| `PW_WORKERS` | Optional | `3` | Number of parallel Playwright workers (e.g. `1`, `4`, `50%`) |
| `PW_GREP` | Optional | — | Regex to filter tests by title (e.g. `SCRUM-T138`) |
| `PORT` | Optional | `3000` | Express server port |
| `JIRA_BUG_ISSUETYPE` | Optional | `Bug` | Issue type for auto-created bugs |
| `WEBHOOK_SECRET` | Optional | — | HMAC secret for Jira webhook validation |
| `WEBHOOK_TRIGGER_STATUSES` | Optional | `In Progress,Selected for Development,To Do` | Jira statuses that trigger pipeline |
| `API_SECRET` | Optional | — | Bearer token for manual trigger endpoint |
| `OPENAI_API_KEY` | Optional | — | OpenAI key (only if using LLM-based generation) |

---

## 17. npm Scripts Reference

| Script | Command | Description |
|---|---|---|
| `npm start` | `node scripts/run-full-pipeline.js` | Full 8-stage autonomous pipeline |
| `npm test` | `npx playwright test` | Run all Playwright tests |
| `npm run qa` | `node scripts/qa-run.js` | Full 8-stage pipeline |
| `npm run qa:run` | `node scripts/qa-run.js --run-only` | Execute + report only (skip gen) |
| `npm run qa:generate` | `node scripts/qa-run.js --skip-story` | Generate specs only (skip fetch) |
| `npm run qa:full` | `node scripts/qa-run.js` | Full pipeline (alias) |
| `npm run report` | `node scripts/generate-report.js` | Generate custom HTML report |
| `npm run report:allure` | `node scripts/generate-allure-report.js` | Generate Allure report |
| `npm run allure:open` | `npx allure open allure-report` | Open Allure report in browser |
| `npm run start:server` | `node src/main.js` | Start Express API server |

### Additional CLI Commands

```bash
# Story-specific test execution
node scripts/run-story-tests.js SCRUM-6

# Tag-filtered test execution
node scripts/run-tagged-tests.js --tag smoke
node scripts/run-tagged-tests.js --tag bva
node scripts/run-tagged-tests.js --tag SCRUM-T36
node scripts/run-tagged-tests.js --tag "boundary|duplicate"
node scripts/run-tagged-tests.js --tag regression --skip-heal

# Git agent standalone
node scripts/git-sync.js --dry-run
node scripts/git-sync.js --skip-push

# Validate integrations
node scripts/validate-integration.js

# Self-healer standalone
node scripts/healer.js --skip-run
```

---

## 18. Quick Start Guide

### Prerequisites

- **Node.js** ≥ 20
- **npm** ≥ 9
- **Git** installed and configured

### Step 1: Install Dependencies

```bash
npm install
npx playwright install --with-deps chromium
```

### Step 2: Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials:
#   JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN
#   PROJECT_KEY, ISSUE_KEY
#   ZEPHYR_BASE_URL, ZEPHYR_ACCESS_KEY
```

### Step 3: Validate Connectivity

```bash
node scripts/validate-integration.js
```

This checks all Jira and Zephyr API connections and reports any issues.

### Step 4: Run the Full Pipeline

```bash
# Full pipeline — headed browser (visible)
npm run qa

# Full pipeline — headless (CI mode)
npm run qa -- --headless

# Skip story fetch + spec gen (re-run existing specs only)
npm run qa:run
```

### Step 5: View Reports

After the pipeline completes, open these reports:

| Report | Location | View Command |
|---|---|---|
| Custom HTML | `custom-report/index.html` | Open in browser |
| Allure | `allure-report/index.html` | `npm run allure:open` |
| Playwright | `playwright-report/index.html` | `npx playwright show-report` |

---

## 19. Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|---|---|---|
| `ZEPHYR_ACCESS_KEY not set` | Missing env var | Add `ZEPHYR_ACCESS_KEY` to `.env` |
| `Global setup failed: AUT unreachable` | OrangeHRM demo site is down | Wait and retry; the demo site has intermittent downtime |
| `Blank Allure report` | Stale `allure-results/` from previous runs | `global-setup.js` auto-cleans this; or manually delete `allure-results/` |
| `Strict mode violation` | Multiple elements match a locator | Healer auto-fixes with `.first()`; or update POM locators |
| `Push failed in Git Agent` | No remote configured or auth issue | Non-fatal; commit is saved locally. Push manually with `git push` |
| `Test timeout (90s)` | AUT slow / network latency | Healer auto-extends timeouts; or increase in `playwright.config.js` |

### Diagnostic Commands

```bash
# Check API connectivity
node scripts/validate-integration.js

# Run single test in debug mode
npx playwright test --grep "SCRUM-T138" --debug

# View test trace
npx playwright show-trace test-results/<trace-file>.zip

# List matching specs for a tag (without running)
node scripts/run-tagged-tests.js --tag smoke --list-only

# Diagnose Zephyr sync (parse test-results.json vs Zephyr)
node scripts/diag-zephyr.js

# Smoke-test AI agents offline (no external API calls)
node scripts/test-agents.js

# Test REST API endpoints (requires server: npm run start:server)
node scripts/test-endpoints.js
```

---

## Architecture Summary

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   JIRA STORY  ──▶  5 AI AGENTS  ──▶  ZEPHYR TCs  ──▶  PLAYWRIGHT SPECS │
│                                                             │            │
│                                                             ▼            │
│                    ┌────────────────────────────────────────────────┐     │
│                    │              TEST EXECUTION                    │     │
│                    └──────────┬─────────────────────────────────────┘     │
│                               │                                          │
│                    ┌──────────┼──────────┐                               │
│                    ▼          ▼          ▼                                │
│              ┌──────────┐ ┌──────┐ ┌──────────┐                          │
│              │ SELF-HEAL│ │ BUGS │ │ 2 REPORTS│                          │
│              └──────────┘ └──────┘ └──────────┘                          │
│                                         │                                │
│                                         ▼                                │
│                                   ┌──────────┐                           │
│                                   │ GIT PUSH │                           │
│                                   └──────────┘                           │
│                                                                          │
│   Zero prompts. Zero manual steps. Full traceability.                    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

*Generated for the Agentic QA Platform — April 20, 2026*
