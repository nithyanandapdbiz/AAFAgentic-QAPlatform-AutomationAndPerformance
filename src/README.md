# Source (`src/`)

Backend server and AI agent orchestration layer for the Agentic QA Platform.

## Architecture

```
src/
├── main.js                    # Express server entry point (port 3000)
├── agents/                    # AI Agents (rule-based, zero external API)
│   ├── planner.agent.js       #   → Breaks stories into test scenarios
│   ├── qa.agent.js            #   → Generates test case details (steps, data)
│   ├── reviewer.agent.js      #   → Reviews and enriches test cases
│   ├── executor.agent.js      #   → Orchestrates Playwright execution
│   └── riskPrioritizer.agent.js  → Assigns risk/priority to test cases
├── api/                       # Express REST API
│   ├── routes.js              #   → Route definitions + auth middleware
│   ├── dashboard.controller.js#   → Dashboard data endpoints
│   ├── screenshot.controller.js  → Screenshot serving endpoint
│   └── webhook.controller.js  #   → Jira/Zephyr webhook handler
├── core/                      # Cross-cutting concerns
│   ├── config.js              #   → Environment config (dotenv)
│   └── errorHandler.js        #   → Express error handler
├── orchestrator/              # Pipeline orchestration
│   ├── agentOrchestrator.js   #   → Multi-agent pipeline coordinator
│   └── finalFlow.js           #   → End-to-end flow: Story → Tests → Report
├── services/                  # Business logic services
│   ├── bug.service.js         #   → Create Jira bugs from failures
│   ├── coverage.service.js    #   → Test coverage analysis
│   ├── cycle.service.js       #   → Zephyr test cycle management
│   ├── execution.service.js   #   → Playwright test execution
│   ├── executionMapping.service.js → Map results to Zephyr executions
│   └── flaky.service.js       #   → Flaky test detection and tracking
├── tools/                     # External API clients
│   ├── jira.client.js         #   → Jira REST API client
│   ├── jiraBug.client.js      #   → Jira bug creation client
│   ├── playwright.generator.js#   → Spec file code generator
│   ├── zephyr.client.js       #   → Zephyr Scale test case API
│   ├── zephyrCycle.client.js  #   → Zephyr Scale cycle API
│   └── zephyrExecution.client.js → Zephyr Scale execution API
└── utils/                     # Shared utilities
    ├── logger.js              #   → Winston logger (console + file)
    ├── resultParser.js        #   → Parse Playwright JSON results
    ├── retry.js               #   → Retry-with-backoff helper
    └── zephyrJwt.js           #   → Zephyr JWT token generation
```

## Data Flow

```
Jira Story → Planner Agent → QA Agent → Reviewer Agent → Risk Prioritizer
    → Zephyr Scale (sync) → Playwright Generator → Test Execution
    → Result Parser → Bug Service + Flaky Detection → Dashboard
```
