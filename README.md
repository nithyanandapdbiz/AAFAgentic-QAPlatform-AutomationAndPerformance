# Agentic QA Platform

End-to-end AI-powered QA automation: **Jira Story → Test Generation → Zephyr Scale → Playwright Execution → Results → Dashboard + Bug Tickets**

---

## Overview

An enterprise-grade QA platform that uses rule-based AI agents to automate the full test lifecycle — from Jira user stories to Playwright spec generation, execution, self-healing, and Jira bug creation.

| Capability | Technology |
|------------|-----------|
| Test Framework | Playwright + Page Object Model |
| Test Management | Zephyr Scale (Jira Cloud) |
| Issue Tracking | Jira REST API |
| AI Agents | Rule-based (Planner, QA, Reviewer, Executor, Risk Prioritizer) |
| Dashboard API | Express.js (port 3000) |
| CI/CD | GitHub Actions |
| Reporting | Allure + Custom HTML |

---

## Project Structure

```
agentic-qa-platform-full/
│
├── src/                           # Backend server + AI agent layer
│   ├── main.js                    #   Express server entry point
│   ├── agents/                    #   AI agents (planner, qa, reviewer, executor, risk)
│   ├── api/                       #   REST API (dashboard, webhooks, screenshots)
│   ├── core/                      #   Config + error handling
│   ├── orchestrator/              #   Pipeline orchestration (agent coordinator, final flow)
│   ├── services/                  #   Business logic (bugs, coverage, cycles, execution, flaky)
│   ├── tools/                     #   External API clients (Jira, Zephyr, Playwright generator)
│   └── utils/                     #   Shared utilities (logger, parser, retry, JWT)
│
├── tests/                         # Playwright test framework
│   ├── global-setup.js            #   Auth + browser warmup
│   ├── global-teardown.js         #   Cleanup
│   ├── data/                      #   Test data + credentials
│   ├── fixtures/                  #   Composed Playwright fixtures (POM + hooks)
│   ├── helpers/                   #   Helpers (screenshots, locator loader)
│   ├── pages/                     #   Page Object Model (.js class + .yml locators)
│   └── specs/                     #   Auto-generated test specs (SCRUM-T*.spec.js)
│
├── scripts/                       #  CLI scripts (pipeline runners, generators, diagnostics)
├── dashboard/                     #  React dashboard (separate package)
│
├── .github/workflows/qa.yml      #  GitHub Actions CI pipeline
├── playwright.config.js           #  Playwright configuration
├── .eslintrc.json                 #  ESLint rules
├── .env.example                   #  Environment variable template
└── package.json                   #  Dependencies + npm scripts
```

> Each directory contains its own `README.md` with detailed documentation.

---

## Quick Start

### Prerequisites

- Node.js ≥ 20
- npm ≥ 9

### Installation

```bash
npm install
npx playwright install --with-deps chromium
```

### Environment Setup

```bash
cp .env.example .env
# Edit .env with your Jira and Zephyr Scale credentials
```

### Running Tests

```bash
# Run all Playwright tests (headed mode)
npm test

# Run in headless mode (CI)
PW_HEADLESS=true npm test

# Run specific test case
npx playwright test --grep "SCRUM-T138"

# Run with custom worker count
PW_WORKERS=2 npm test
```

### Full QA Pipeline

```bash
# Full pipeline: Story → Generate → Run → Heal → Bugs → Report
npm start

# Configurable pipeline
npm run qa                         # Full pipeline (all stages)
npm run qa:run                     # Execute + report only (skip generation)
npm run qa:generate                # Generate specs only (skip story fetch)
```

### Reports

```bash
npm run report                     # Custom HTML report
npm run report:allure              # Allure report generation
npm run allure:open                # Open Allure report in browser
```

### Dashboard API

```bash
npm run start:server               # Start Express server on port 3000
```

---

## CI/CD

GitHub Actions workflow (`.github/workflows/qa.yml`) runs on push to `main` and manual trigger:

1. Install dependencies + Playwright browsers
2. Run full QA pipeline (headless)
3. Upload Playwright report as artifact
4. Commit generated specs back to repo

Required secrets: `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `ZEPHYR_BASE_URL`, `ZEPHYR_ACCESS_KEY`, `ISSUE_KEY`, `PROJECT_KEY`

---

## Architecture

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌───────────────┐
│  Jira Story  │───▶│ Planner Agent│───▶│   QA Agent   │───▶│Reviewer Agent │
└─────────────┘    └──────────────┘    └──────────────┘    └───────┬───────┘
                                                                   │
                   ┌──────────────┐    ┌──────────────┐            │
                   │  Dashboard   │◀───│ Bug Service   │◀───┐      ▼
                   └──────────────┘    └──────────────┘    │  ┌──────────────┐
                                                           │  │Risk Prioritize│
                   ┌──────────────┐    ┌──────────────┐    │  └──────┬───────┘
                   │ Allure Report│◀───│Result Parser  │◀───┤         │
                   └──────────────┘    └──────────────┘    │         ▼
                                                           │  ┌──────────────┐
                                       ┌──────────────┐    │  │ Zephyr Scale │
                                       │  Self-Healer │◀───┤  └──────┬───────┘
                                       └──────────────┘    │         │
                                                           │         ▼
                                       ┌──────────────┐    │  ┌──────────────┐
                                       │  Playwright   │───▶┘  │  Spec Gen    │
                                       │  Execution    │◀──────│  (POM + Eyes)│
                                       └──────────────┘       └──────────────┘
```
