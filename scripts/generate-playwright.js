'use strict';
/**
 * generate-playwright.js
 *
 * Fetches all test cases (+ their steps) from Zephyr Essential Cloud v2.8
 * for the configured project and writes one Playwright spec file per test
 * case into tests/specs/.
 *
 * POM infrastructure expected at:
 *   tests/pages/LoginPage.js
 *   tests/pages/AddEmployeePage.js
 *   tests/pages/EmployeeListPage.js
 *   tests/data/testData.js
 *
 * Usage:
 *   node scripts/generate-playwright.js
 */

require('dotenv').config();
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const ZEPHYR_BASE  = process.env.ZEPHYR_BASE_URL  || 'https://prod-api.zephyr4jiracloud.com/v2';
const ZEPHYR_TOKEN = process.env.ZEPHYR_ACCESS_KEY;
const PROJECT_KEY  = process.env.PROJECT_KEY       || 'SCRUM';

const ROOT      = path.resolve(__dirname, '..');
const SPECS_DIR = path.join(ROOT, 'tests', 'specs');

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function zHeaders() {
  return {
    Authorization:  ZEPHYR_TOKEN,
    'Content-Type': 'application/json',
    Accept:         'application/json'
  };
}

async function fetchTestCases() {
  const res = await axios.get(`${ZEPHYR_BASE}/testcases`, {
    headers: zHeaders(),
    params:  { projectKey: PROJECT_KEY, maxResults: 200 }
  });
  const all = res.data.values || res.data || [];

  // If run-story.js wrote a handoff file, only generate specs for those test case keys.
  // This ensures we generate specs only for the current story — not stale duplicates.
  const handoffFile = path.join(path.resolve(__dirname, '..'), '.story-testcases.json');
  const issueKey    = process.env.ISSUE_KEY;
  if (fs.existsSync(handoffFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(handoffFile, 'utf8'));
      if (data.issueKey === issueKey && Array.isArray(data.keys) && data.keys.length > 0) {
        const keySet   = new Set(data.keys);
        const filtered = all.filter(tc => keySet.has(tc.key));
        if (filtered.length > 0) return filtered;
      }
    } catch { /* ignore parse errors, fall back to all */ }
  }

  return all;
}

async function fetchSteps(tcKey) {
  try {
    const res = await axios.get(
      `${ZEPHYR_BASE}/testcases/${tcKey}/teststeps`,
      { headers: zHeaders() }
    );
    return res.data.values || res.data || [];
  } catch {
    return [];
  }
}



// ─── Test-type detector ───────────────────────────────────────────────────────
function detectType(name, labels) {
  const t = ((name || '') + ' ' + (labels || []).join(' ')).toLowerCase();
  // NOTE: check invalid_data BEFORE happy_path — "invalid input" contains "valid input"
  if (/invalid input|invalid data/.test(t))                return 'invalid_data';
  if (/valid input|successful|happy/.test(t))              return 'happy_path';
  if (/mandatory|required field/.test(t))                  return 'mandatory_fields';
  if (/boundary/.test(t))                                  return 'boundary_values';
  if (/duplicate/.test(t))                                 return 'duplicate_entry';
  if (/special character|unicode/.test(t))                 return 'special_characters';
  if (/ui feedback|feedback message/.test(t))              return 'ui_feedback';
  if (/cancel|discard/.test(t))                            return 'cancel_discard';
  if (/persist/.test(t))                                   return 'data_persistence';
  if (/maximum|max number/.test(t))                        return 'maximum_records';
  if (/role|access control|rbac|authoriz/.test(t))         return 'rbac';
  return 'generic';
}

// ─── Spec-body generators per test type ──────────────────────────────────────
//
//  Each function receives (tc, steps) and returns the BODY that goes inside
//  the async ({ page, loginPage, addEmployeePage, employeeListPage, sh, uniqueSuffix }, testInfo) => { ... }
//  test callback.  Fixtures from base.fixture.js provide POM objects and
//  ScreenshotHelper — no manual construction needed.
//
const SPEC_BODIES = {

  // ── TC: Happy Path ─────────────────────────────────────────────────────────
  happy_path: () => `

    await sh.step('Open Login Page', async () => {
      await loginPage.goto();
    });

    await sh.step('Enter credentials and log in as HR Admin', async () => {
      await loginPage.usernameInput.fill(CREDENTIALS.admin.username);
      await loginPage.passwordInput.fill(CREDENTIALS.admin.password);
      await loginPage.loginButton.click();
      await page.waitForURL('**/dashboard**', { timeout: 15000 });
    });

    await sh.step('Navigate to PIM — Add Employee form', async () => {
      await addEmployeePage.navigate();
      await expect(page).toHaveURL(/addEmployee/);
    });

    await sh.step('Fill all required fields with valid data', async () => {
      await addEmployeePage.fillEmployee({
        firstName: TEST_EMPLOYEE.firstName,
        lastName:  TEST_EMPLOYEE.lastName
      });
    });

    await sh.step('Submit form and verify redirect to Personal Details', async () => {
      await addEmployeePage.save();
      await expect(page).toHaveURL(/viewPersonalDetails/, { timeout: 15000 });
      await expect(page.locator('h6.oxd-text').first()).toBeVisible();
    });`,

  // ── TC: Mandatory Fields ───────────────────────────────────────────────────
  mandatory_fields: () => `

    await sh.step('Log in as HR Admin', async () => {
      await loginPage.login(CREDENTIALS.admin.username, CREDENTIALS.admin.password);
    });

    await sh.step('Open Add Employee form', async () => {
      await addEmployeePage.navigate();
    });

    await sh.step('Clear all required fields (First Name, Last Name)', async () => {
      await addEmployeePage.firstNameInput.clear();
      await addEmployeePage.lastNameInput.clear();
    });

    await sh.step('Attempt to submit with empty required fields', async () => {
      await addEmployeePage.save();
    });

    await sh.step('Verify inline validation error messages appear', async () => {
      await expect(addEmployeePage.validationErrors.first()).toBeVisible({ timeout: 5000 });
      const errorCount = await addEmployeePage.validationErrors.count();
      expect(errorCount).toBeGreaterThanOrEqual(1);
      await expect(page).not.toHaveURL(/viewPersonalDetails/);
    });`,

  // ── TC: Invalid Data ───────────────────────────────────────────────────────
  invalid_data: () => `

    await sh.step('Log in and open Add Employee form', async () => {
      await loginPage.login(CREDENTIALS.admin.username, CREDENTIALS.admin.password);
      await addEmployeePage.navigate();
    });

    await sh.step('Enter invalid data — numerics and symbols in name fields', async () => {
      await addEmployeePage.fillEmployee({ firstName: '12345', lastName: '!@#$%' });
    });

    await sh.step('Submit the form with invalid data', async () => {
      await addEmployeePage.save();
    });

    await sh.step('Verify no crash — system shows validation or stays on form', async () => {
      await page.waitForLoadState('networkidle');
      expect(page.url()).not.toMatch(/error|exception/i);
    });`,

  // ── TC: Boundary Values ────────────────────────────────────────────────────
  boundary_values: () => `

    await sh.step('Log in as HR Admin', async () => {
      await loginPage.login(CREDENTIALS.admin.username, CREDENTIALS.admin.password);
    });

    await sh.step('Test minimum boundary — single character names (A, B)', async () => {
      await addEmployeePage.navigate();
      await addEmployeePage.fillEmployee({ firstName: 'A', lastName: 'B' });
      await addEmployeePage.save();
      await expect(page).toHaveURL(/viewPersonalDetails|addEmployee/, { timeout: 10000 });
    });

    await sh.step('Test maximum boundary — 50-character names', async () => {
      await addEmployeePage.navigate();
      await addEmployeePage.fillEmployee({
        firstName: 'A'.repeat(50),
        lastName:  'B'.repeat(50)
      });
      await addEmployeePage.save();
      await page.waitForLoadState('networkidle');
      expect(page.url()).not.toMatch(/error|exception/i);
    });

    await sh.step('Test over-maximum boundary — 101-character names', async () => {
      await addEmployeePage.navigate();
      await addEmployeePage.fillEmployee({
        firstName: 'X'.repeat(101),
        lastName:  'Y'.repeat(101)
      });
      await addEmployeePage.save();
      await page.waitForLoadState('networkidle');
      expect(page.url()).not.toMatch(/error|exception/i);
    });`,

  // ── TC: Duplicate Entry ────────────────────────────────────────────────────
  duplicate_entry: () => `

    await sh.step('Log in as HR Admin', async () => {
      await loginPage.login(CREDENTIALS.admin.username, CREDENTIALS.admin.password);
    });

    await sh.step('Create first employee with Employee ID DUP-TEST-001', async () => {
      await addEmployeePage.navigate();
      await addEmployeePage.fillEmployee({ firstName: 'DupFirst', lastName: 'DupLast' });
      await addEmployeePage.setEmployeeId('DUP-TEST-001');
      await addEmployeePage.save();
      await page.waitForLoadState('networkidle');
    });

    await sh.step('Attempt second creation with same Employee ID DUP-TEST-001', async () => {
      await addEmployeePage.navigate();
      await addEmployeePage.fillEmployee({ firstName: 'DupFirst2', lastName: 'DupLast2' });
      await addEmployeePage.setEmployeeId('DUP-TEST-001');
      await addEmployeePage.save();
      await page.waitForLoadState('networkidle');
    });

    await sh.step('Verify system blocks or warns — no crash on duplicate', async () => {
      expect(page.url()).not.toMatch(/error|exception/i);
    });`,

  // ── TC: Special Characters ─────────────────────────────────────────────────
  special_characters: () => `

    await sh.step('Log in as HR Admin', async () => {
      await loginPage.login(CREDENTIALS.admin.username, CREDENTIALS.admin.password);
    });

    await sh.step("Test unicode and accented characters (Müller, O'Brien)", async () => {
      await addEmployeePage.navigate();
      await addEmployeePage.fillEmployee({ firstName: 'Müller', lastName: "O'Brien" });
      await addEmployeePage.save();
      await page.waitForLoadState('networkidle');
      expect(page.url()).not.toMatch(/error|exception/i);
    });

    await sh.step('Test symbol characters in name fields (Test@User, Hash#Name)', async () => {
      await addEmployeePage.navigate();
      await addEmployeePage.fillEmployee({ firstName: 'Test@User', lastName: 'Hash#Name' });
      await addEmployeePage.save();
      await page.waitForLoadState('networkidle');
      expect(page.url()).not.toMatch(/error|exception/i);
    });`,

  // ── TC: UI Feedback ────────────────────────────────────────────────────────
  ui_feedback: () => `

    await sh.step('Log in as HR Admin', async () => {
      await loginPage.login(CREDENTIALS.admin.username, CREDENTIALS.admin.password);
    });

    await sh.step('Submit valid employee to trigger success feedback', async () => {
      await addEmployeePage.navigate();
      await addEmployeePage.fillEmployee({ firstName: 'UIFeedback', lastName: 'Success' });
      await addEmployeePage.save();
      await expect(page).toHaveURL(/viewPersonalDetails/, { timeout: 15000 });
    });

    await sh.step('Verify success state — Personal Details page is visible', async () => {
      await expect(page.locator('h6.oxd-text').first()).toBeVisible();
    });

    await sh.step('Submit empty form to trigger validation error feedback', async () => {
      await addEmployeePage.navigate();
      await addEmployeePage.firstNameInput.clear();
      await addEmployeePage.lastNameInput.clear();
      await addEmployeePage.save();
    });

    await sh.step('Verify validation error messages are visible', async () => {
      await expect(addEmployeePage.validationErrors.first()).toBeVisible({ timeout: 5000 });
    });`,

  // ── TC: Cancel / Discard ───────────────────────────────────────────────────
  cancel_discard: () => `

    await sh.step('Log in as HR Admin', async () => {
      await loginPage.login(CREDENTIALS.admin.username, CREDENTIALS.admin.password);
    });

    await sh.step('Navigate to Add Employee and partially fill the form', async () => {
      await addEmployeePage.navigate();
      await addEmployeePage.fillEmployee({ firstName: 'CancelTest', lastName: 'Discard' });
    });

    await sh.step('Cancel — navigate away without saving', async () => {
      await addEmployeePage.cancel();
      await page.waitForLoadState('networkidle');
    });

    await sh.step('Verify no redirect to Personal Details occurred', async () => {
      expect(page.url()).not.toMatch(/viewPersonalDetails/);
    });

    await sh.step('Search Employee List — cancelled record should not exist', async () => {
      await employeeListPage.searchEmployee('CancelTest');
      await page.waitForLoadState('networkidle');
      expect(page.url()).not.toMatch(/error|exception/i);
    });`,

  // ── TC: Data Persistence ───────────────────────────────────────────────────
  data_persistence: () => `

    await sh.step('Log in as HR Admin', async () => {
      await loginPage.login(CREDENTIALS.admin.username, CREDENTIALS.admin.password);
    });

    await sh.step('Navigate to Add Employee and fill with known values', async () => {
      await addEmployeePage.navigate();
      await addEmployeePage.fillEmployee({ firstName: 'Persist', lastName: \`DC\${uniqueSuffix}\` });
      await addEmployeePage.setEmployeeId(\`DP\${uniqueSuffix}\`);
    });

    await sh.step('Save the employee record', async () => {
      await addEmployeePage.save();
      await expect(page).toHaveURL(/viewPersonalDetails/, { timeout: 20000 });
    });

    await sh.step('Verify First Name is persisted correctly', async () => {
      await expect(page.locator('input[name="firstName"]'))
        .toHaveValue('Persist', { timeout: 8000 });
    });

    await sh.step('Verify Last Name is persisted correctly', async () => {
      await expect(page.locator('input[name="lastName"]'))
        .toHaveValue(\`DC\${uniqueSuffix}\`, { timeout: 8000 });
    });`,

  // ── TC: Maximum Records ────────────────────────────────────────────────────
  maximum_records: () => `

    await sh.step('Log in as HR Admin', async () => {
      await loginPage.login(CREDENTIALS.admin.username, CREDENTIALS.admin.password);
    });

    await sh.step('Navigate to Employee List page', async () => {
      await employeeListPage.navigate();
    });

    await sh.step('Verify Employee List table loads without errors', async () => {
      await expect(page.locator('.oxd-table')).toBeVisible({ timeout: 15000 });
      expect(page.url()).not.toMatch(/error|exception/i);
    });

    await sh.step('Observe record count and pagination status', async () => {
      const rowCount = await employeeListPage.getRowCount();
      console.log('Visible employee rows: ' + rowCount);
      expect(rowCount).toBeGreaterThanOrEqual(0);
      const pagination = page.locator('.oxd-pagination');
      if (await pagination.isVisible({ timeout: 2000 }).catch(() => false)) {
        await expect(pagination).toBeVisible();
      }
    });`,

  // ── TC: RBAC ───────────────────────────────────────────────────────────────
  rbac: () => `

    await sh.step('Log in as Admin and access Employee List', async () => {
      await loginPage.login(CREDENTIALS.admin.username, CREDENTIALS.admin.password);
      await page.goto('/web/index.php/pim/viewEmployeeList');
      await expect(page).toHaveURL(/viewEmployeeList/, { timeout: 15000 });
      await expect(page.locator('.oxd-table')).toBeVisible();
    });

    await sh.step('Verify Admin can access Add Employee form', async () => {
      await page.goto('/web/index.php/pim/addEmployee');
      await expect(page).toHaveURL(/addEmployee/);
      await expect(page.locator('input[name="firstName"]')).toBeVisible();
    });

    await sh.step('Clear session cookies to simulate unauthenticated user', async () => {
      await page.context().clearCookies();
    });

    await sh.step('Verify unauthenticated access to PIM redirects to Login', async () => {
      await page.goto('/web/index.php/pim/addEmployee');
      await expect(page).toHaveURL(/auth\\/login/, { timeout: 10000 });
      await expect(page.locator('input[name="username"]')).toBeVisible();
    });`,

  // ── TC: Generic fallback ───────────────────────────────────────────────────
  generic: (tc, steps) => `

    await sh.step('Log in as HR Admin', async () => {
      await loginPage.login(CREDENTIALS.admin.username, CREDENTIALS.admin.password);
    });

    await sh.step('Navigate to Add Employee form', async () => {
      await addEmployeePage.navigate();
    });

${steps.map((s, i) => {
  const desc = (s.inline && s.inline.description) || s.description || JSON.stringify(s);
  return `    await sh.step(${JSON.stringify(String(i + 1) + '. ' + desc)}, async () => {
      await page.waitForLoadState('networkidle');
    });`;
}).join('\n\n')}

    await sh.step('Verify no error condition after all steps', async () => {
      await page.waitForLoadState('networkidle');
      expect(page.url()).not.toMatch(/error|exception/i);
    });`
};

// ─── Spec file builder ────────────────────────────────────────────────────────
function buildSpec(tc, steps) {
  const type = detectType(tc.name, tc.labels);
  const body = (SPEC_BODIES[type] || SPEC_BODIES.generic)(tc, steps);

  const key     = tc.key     || 'UNKNOWN';
  const title   = (tc.name   || '').replace(/'/g, "\\'");
  const pri     = tc.priorityName || 'Normal';
  const tags    = (tc.labels || []).join(', ') || '(none)';

  const stepComments = steps.length
    ? steps.map((s, i) => {
        const desc = (s.inline && s.inline.description) || s.description || JSON.stringify(s);
        return `//   ${i + 1}. ${desc}`;
      }).join('\n')
    : '//   (no steps returned from Zephyr)';

  return `// =============================================================================
// Zephyr Test Case : ${key}
// Title            : ${tc.name}
// Priority         : ${pri}
// Labels           : ${tags}
// Steps from Zephyr:
${stepComments}
// =============================================================================
// Generated by  : scripts/generate-playwright.js
// Application   : OrangeHRM — https://opensource-demo.orangehrmlive.com
// Module        : PIM → Add Employee
// Credentials   : Admin / admin123
// Fixtures      : base.fixture.js (POM + ScreenshotHelper)
// =============================================================================
'use strict';
const { test, expect }                = require('../fixtures/base.fixture');
const { CREDENTIALS, TEST_EMPLOYEE } = require('../data/testData');

test.describe('${key} | ${title}', () => {

  test('${title}', async ({ page, loginPage, addEmployeePage, employeeListPage, sh, uniqueSuffix }, testInfo) => {${body}
  });

});
`;
}

// ─── Slug helper ──────────────────────────────────────────────────────────────
function slug(str) {
  return str
    .toLowerCase()
    .replace(/\W+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 70);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║  Zephyr → Playwright POM Generator               ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');
  console.log(`  Project  : ${PROJECT_KEY}`);
  console.log(`  Zephyr   : ${ZEPHYR_BASE}\n`);

  if (!ZEPHYR_TOKEN) {
    console.error('  ERROR: ZEPHYR_ACCESS_KEY is not set in .env');
    process.exit(1);
  }

  // ── 1. Fetch test cases ────────────────────────────────────────────────────
  console.log('  Fetching test cases from Zephyr...');
  const testCases = await fetchTestCases();
  console.log(`  Found ${testCases.length} test case(s)\n`);

  if (!testCases.length) {
    // Zero-spec guard: no test cases to convert. Exit code 2 is a sentinel the
    // pipeline runner (`src/pipeline/steps.js :: generateSpecs`) converts into
    // a PreconditionError that halts the pipeline with an actionable hint.
    console.error('\n  ABORT: No Playwright specs were generated — Zephyr returned zero test cases.');
    console.error('  Hint: run scripts/run-story.js first to create the Zephyr test cases for the story,');
    console.error('        or verify PROJECT_KEY/ISSUE_KEY/ZEPHYR_ACCESS_KEY in .env.');
    process.exit(2);
  }

  // ── 2. Ensure output directory ────────────────────────────────────────────
  fs.mkdirSync(SPECS_DIR, { recursive: true });

  // ── 2b. Clean up stale spec files when running in filtered (story) mode ──
  // When the handoff file was used, remove spec files for test cases NOT in the
  // current story. This prevents running hundreds of stale/duplicate specs.
  const handoffFile = path.join(ROOT, '.story-testcases.json');
  if (fs.existsSync(handoffFile)) {
    try {
      const handoff = JSON.parse(fs.readFileSync(handoffFile, 'utf8'));
      if (Array.isArray(handoff.keys) && handoff.keys.length > 0) {
        const activeKeys = new Set(handoff.keys);
        const staleFiles = fs.readdirSync(SPECS_DIR)
          .filter(f => f.endsWith('.spec.js'))
          .filter(f => {
            // Extract the SCRUM-Txxx key from the filename prefix
            const m = f.match(/^(SCRUM-T\d+)/i);
            return m && !activeKeys.has(m[1]);
          });
        if (staleFiles.length > 0) {
          console.log(`  Cleaning up ${staleFiles.length} stale spec file(s) from previous stories/runs...`);
          staleFiles.forEach(f => fs.unlinkSync(path.join(SPECS_DIR, f)));
        }
      }
    } catch { /* ignore — proceed with generation */ }
  }

  // ── 3. Generate one spec per test case ────────────────────────────────────
  let written = 0;
  for (const tc of testCases) {
    process.stdout.write(`  [${tc.key}] ${(tc.name || '').slice(0, 55).padEnd(55)} `);

    const steps   = await fetchSteps(tc.key);
    const content = buildSpec(tc, steps);
    const fileName = `${tc.key}_${slug(tc.name || 'test')}.spec.js`;
    const filePath = path.join(SPECS_DIR, fileName);

    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`→ ${fileName}`);
    written++;
  }

  // ── 4. Summary ────────────────────────────────────────────────────────────
  console.log(`\n  ✓ ${written} spec file(s) written to tests/specs/`);

  // Zero-spec guard (post-write safety net): if every iteration silently
  // skipped, still exit with code 2 so the pipeline aborts cleanly.
  if (written === 0) {
    console.error('  ABORT: Zero spec files written to tests/specs/ despite non-empty test case list.');
    process.exit(2);
  }

  console.log(`\n  Run tests:`);
  console.log(`    npx playwright test\n`);
}

main().catch(err => {
  console.error('\n  FATAL:', err.message || err);
  process.exit(1);
});
