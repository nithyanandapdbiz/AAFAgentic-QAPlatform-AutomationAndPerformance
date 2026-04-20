# Tests

Playwright test framework using Page Object Model (POM) with ScreenshotHelper.

## Structure

```
tests/
├── global-setup.js            # Dir init + AUT health-check + auth cache + cleanup
├── global-teardown.js         # Suite summary + Allure results validation
├── data/
│   └── testData.js            # Centralized test data, credentials, routes
├── fixtures/
│   ├── base.fixture.js        # ★ Master fixture: POM + ScreenshotHelper + lifecycle hooks
│   └── pom.fixture.js         # Lightweight POM-only fixture (no screenshots)
├── helpers/
│   ├── screenshot.helper.js   # Step-based screenshot capture with Allure integration
│   └── locatorLoader.js       # YAML locator file parser for page objects
├── features/
│   └── login/
│       └── login.feature      # Gherkin BDD feature file for login scenarios
├── healed/                    # Auto-generated healed spec copies (self-healer output)
├── pages/                     # Page Object Model classes
│   ├── LoginPage.js           #   → Login page actions and assertions
│   ├── LoginPage.yml          #   → Login page locators (YAML)
│   ├── AddEmployeePage.js     #   → Add Employee form actions
│   ├── AddEmployeePage.yml    #   → Add Employee locators (YAML)
│   ├── EmployeeListPage.js    #   → Employee list/search actions
│   └── EmployeeListPage.yml   #   → Employee list locators (YAML)
└── specs/                     # Test specifications (auto-generated from Zephyr)
    └── SCRUM-T*.spec.js       # One spec per Zephyr test case (currently T138–T154)
```

## Key Patterns

- **Page Object Model**: Each page has a `.js` class + `.yml` locator file
- **YAML Locators**: Selectors are externalized in YAML files, loaded by `locatorLoader.js`
- **Composed Fixtures**: `base.fixture.js` merges POM instances and ScreenshotHelper into a single import
- **Hook Lifecycle**: beforeEach (cookie clear), afterEach (failure screenshot + console errors), beforeAll/afterAll (suite logging)

## Running Tests

```bash
npx playwright test                           # Run all specs
npx playwright test --grep "SCRUM-T138"      # Run specific test case
PW_HEADLESS=true npx playwright test          # Headless mode (CI)
PW_WORKERS=1 npx playwright test             # Serial execution (debug)
```
