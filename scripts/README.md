# Scripts

CLI scripts for the Agentic QA Platform. All scripts are run from the project root via `node scripts/<name>.js`.

---

## Pipeline Runners

| Script | Purpose |
|--------|---------|
| `run-full-pipeline.js` | End-to-end pipeline: Story → Generate → Run → Heal → Bugs → Report |
| `qa-run.js` | Configurable QA orchestrator (`--skip-story`, `--run-only`, `--headless`, etc.) |
| `run-and-sync.js` | Run tests and sync results to Zephyr Scale |
| `run-story.js` | Process a single Jira story into Zephyr test cases |
| `run-story-tests.js` | Generate specs from story and execute them |
| `run-tagged-tests.js` | Run tests filtered by tag (`--tag smoke`, `--tag SCRUM-T138`) |

## Generators

| Script | Purpose |
|--------|---------|
| `generate-playwright.js` | Generate Playwright spec files from Zephyr test cases |
| `generate-report.js` | Generate custom HTML report from test results |
| `generate-allure-report.js` | Generate Allure report from `allure-results/` |
| `create-jira-bugs.js` | Create Jira bug tickets for failed tests |
| `healer.js` | Self-heal failing tests (retry with updated locators) |

## Diagnostics

| Script | Purpose |
|--------|---------|
| `diag-zephyr.js` | Diagnose Zephyr Scale API connectivity |
| `test-agents.js` | Smoke-test all AI agents (Planner, QA, Reviewer, etc.) |
| `test-endpoints.js` | Smoke-test all Express API endpoints |
| `validate-integration.js` | Validate end-to-end integration (Jira + Zephyr + Playwright) |
## Utilities

| Script | Purpose |
|--------|----------|
| `ensure-dirs.js` | Create and manage all output directories; wipe stale contents pre-run |
| `git-sync.js` | Git agent — `git add -A` → commit → push to current branch |