'use strict';
const { extractText } = require("./planner.agent");
const logger = require("../utils/logger");
const { logDecision } = require("./agentDecisionLog");
const { validateQAOutput, sanitizeQAOutput } = require("../core/schemas");

// ─── GWT step classifier ──────────────────────────────────────────────────────
/**
 * Converts a flat step array into Given/When/Then/And steps.
 *
 * Classification rules (applied in order):
 *   Given  — pre-conditions, setup, navigation prerequisites
 *   When   — actions, user interactions (click, enter, submit, navigate TO)
 *   Then   — verifications, assertions, post-condition checks
 *   And    — continuation of the previous keyword category
 *
 * Returns: array of { keyword, text, description } objects.
 * `description` is the GWT-prefixed string stored in Zephyr.
 */
function stepsToGWT(steps) {
  const givenSignals = /pre-condition|user is logged|browser is open|navigate.*login|start.*clean|clear.*session/i;
  const thenSignals  = /verify|assert|confirm|check|ensure|should|must|expect|no.*record|is displayed|is visible|redirects|remains|not.*contain|not.*match/i;
  const whenSignals  = /enter|fill|click|submit|navigate to|attempt|perform|open|log in|clear|set|select|search/i;

  let lastKeyword = 'Given';
  return steps.map((s, i) => {
    const text = typeof s === 'string' ? s : (s.description || s.text || String(s));
    let keyword;
    if (i === 0 || givenSignals.test(text)) {
      keyword = 'Given';
    } else if (thenSignals.test(text)) {
      keyword = 'Then';
    } else if (whenSignals.test(text)) {
      keyword = 'When';
    } else {
      keyword = lastKeyword === 'Given' ? 'When' : (lastKeyword === 'When' ? 'And' : 'And');
    }
    lastKeyword = keyword === 'And' ? lastKeyword : keyword;
    return { keyword, text, description: `${keyword} ${text}` };
  });
}

/**
 * QA Agent — rule-based test case generator (no external AI required).
 *
 * Generates detailed test cases from a Jira story using structured templates
 * per test type. Each test case includes:
 *   title, description, designTechnique, steps[] (with test data), testData[],
 *   expected, priority, tags[]
 *
 * Design Techniques applied:
 *   EP  — Equivalence Partitioning  (happy-path, mandatory, invalid)
 *   BVA — Boundary Value Analysis   (boundary, max-records)
 *   EG  — Error Guessing            (special chars, duplicate, cancel)
 *   ST  — State Transition          (data persistence flow)
 *   UC  — Use Case / Scenario       (acceptance criteria, RBAC)
 *   DT  — Decision Table            (RBAC role combinations)
 */

// ── Template builders per test type ──────────────────────────────────
const TEMPLATES = [
  {
    build(subject) {
      return {
        title: `Verify successful ${subject} with valid inputs`,
        description: `Ensure that ${subject} completes successfully when all required fields are provided with valid data.`,
        designTechnique: "Equivalence Partitioning (EP) — Valid Partition",
        testData: [
          { field: "First Name", value: "AutoTest", partition: "Valid — alphabetic, 1–50 chars" },
          { field: "Last Name",  value: "Employee",  partition: "Valid — alphabetic, 1–50 chars" },
          { field: "Username",   value: "autotest01", partition: "Valid — alphanumeric, unique" }
        ],
        steps: [
          `[Pre-condition] User is logged out. Browser is open at the application URL.`,
          `Navigate to the application login page and log in with valid admin credentials (Username: Admin, Password: admin123).`,
          `Navigate to the ${subject} page or form via the main navigation menu.`,
          `Verify the form/page loads completely with all fields visible.`,
          `Fill in First Name field with valid test data: "AutoTest" (alphabetic, within 1–50 char limit).`,
          `Fill in Last Name field with valid test data: "Employee" (alphabetic, within 1–50 char limit).`,
          `Fill in any other required fields with valid test data as per test data table.`,
          `Click the Save / Submit button to trigger the action.`,
          `Wait for the system response (success message or redirect).`,
          `Verify a success confirmation message is displayed (e.g. "Successfully Saved").`,
          `Verify the system redirects to the expected page (e.g. employee detail view).`,
          `[Post-condition] Verify the new record appears in the list/search results.`
        ],
        expected: `${subject} completes successfully. A success message is displayed. Data is persisted and visible in the system. No errors occur.`,
        priority: "High",
        tags: ["happy-path", "smoke", "ep-valid"]
      };
    }
  },
  {
    build(subject) {
      return {
        title: `Verify mandatory fields are enforced for ${subject}`,
        description: `Ensure the system prevents submission when required fields are empty.`,
        designTechnique: "Equivalence Partitioning (EP) — Empty/Null Partition",
        testData: [
          { field: "First Name", value: "", partition: "Invalid — empty string" },
          { field: "Last Name",  value: "", partition: "Invalid — empty string" }
        ],
        steps: [
          `[Pre-condition] User is logged in as Admin.`,
          `Navigate to the ${subject} page or form.`,
          `Leave the First Name field completely empty (do not enter any value).`,
          `Leave the Last Name field completely empty (do not enter any value).`,
          `Leave any other mandatory fields empty.`,
          `Click the Save / Submit button without filling any required fields.`,
          `Observe all inline validation messages that appear below each empty field.`,
          `Verify the form does NOT submit (URL remains on the form page).`,
          `Verify the First Name field shows an error message (e.g. "Required").`,
          `Verify the Last Name field shows an error message (e.g. "Required").`,
          `[Negative check] Verify no partial record is created in the system.`
        ],
        expected: `Submission is blocked. Inline validation error messages appear for each required field. No data is saved. URL does not change to confirmation page.`,
        priority: "High",
        tags: ["validation", "negative", "required-fields", "ep-empty"]
      };
    }
  },
  {
    build(subject) {
      return {
        title: `Verify ${subject} rejects invalid input data`,
        description: `Ensure the system shows appropriate errors when invalid values are submitted.`,
        designTechnique: "Equivalence Partitioning (EP) — Invalid Partition + Error Guessing (EG)",
        testData: [
          { field: "First Name", value: "12345",    partition: "Invalid — numerics only" },
          { field: "First Name", value: "!@#$%^&*", partition: "Invalid — special characters" },
          { field: "Last Name",  value: "<script>", partition: "Invalid — HTML injection attempt (EG)" },
          { field: "Username",   value: "a b c",    partition: "Invalid — spaces in username" }
        ],
        steps: [
          `[Pre-condition] User is logged in as Admin. Navigate to ${subject} form.`,
          `Enter numeric-only value "12345" in the First Name field.`,
          `Enter special characters "!@#$%^&*" in the Last Name field.`,
          `Click Save / Submit and observe any validation errors shown.`,
          `Clear the fields and enter HTML injection attempt "<script>alert(1)</script>" in First Name.`,
          `Click Save / Submit and verify the system handles this without executing script.`,
          `Clear the fields and enter a value with spaces "John Doe Smith" in a username-type field.`,
          `Submit and observe system response (expect validation error or sanitised output).`,
          `Verify no system crash, 500 error, or unhandled exception occurs at any point.`,
          `[Post-condition] Confirm no invalid records were persisted in the database.`
        ],
        expected: `System displays descriptive validation errors for invalid inputs. No system errors or crashes occur. No invalid data is saved. HTML/script injection is neutralised.`,
        priority: "High",
        tags: ["negative", "invalid-data", "validation", "ep-invalid", "security-eg"]
      };
    }
  },
  {
    build(subject) {
      return {
        title: `Verify boundary values are handled correctly for ${subject}`,
        description: `Test minimum, maximum, just-below-maximum, and just-over-maximum input lengths and numeric values.`,
        designTechnique: "Boundary Value Analysis (BVA) — Min, Min+1, Max-1, Max, Max+1",
        testData: [
          { field: "First Name", value: "A",            bva: "Min (1 char)" },
          { field: "First Name", value: "AB",           bva: "Min+1 (2 chars)" },
          { field: "First Name", value: "A".repeat(49), bva: "Max-1 (49 chars)" },
          { field: "First Name", value: "A".repeat(50), bva: "Max (50 chars)" },
          { field: "First Name", value: "A".repeat(51), bva: "Max+1 (51 chars) — should be rejected" }
        ],
        steps: [
          `[Pre-condition] User is logged in as Admin. Navigate to ${subject} form.`,
          `[BVA-1] Enter minimum boundary value: single character "A" in First Name and "B" in Last Name. Submit and verify the form accepts it.`,
          `[BVA-2] Enter Min+1 boundary value: two characters "AB" in First Name. Submit and verify acceptance.`,
          `[BVA-3] Navigate back and enter Max-1 boundary value: 49-character string in First Name. Submit and verify acceptance.`,
          `[BVA-4] Navigate back and enter the exact maximum boundary: 50-character string in First Name. Submit and verify acceptance.`,
          `[BVA-5] Navigate back and enter Max+1 boundary: 51-character string in First Name. Submit and verify rejection with error message.`,
          `Record actual system behaviour for each boundary point in a table.`,
          `Verify that accepted boundary values are correctly persisted and displayed.`
        ],
        expected: `Min (1 char) and Max (50 chars) values are accepted and saved. Max+1 (51 chars) is rejected with a clear field-level error. Min-1 (0 chars / empty) is rejected as mandatory. System does not crash at any boundary.`,
        priority: "Normal",
        tags: ["boundary", "edge-case", "bva"]
      };
    }
  },
  {
    build(subject) {
      return {
        title: `Verify duplicate ${subject} is prevented`,
        description: `Ensure the system does not allow creating duplicate records for ${subject}.`,
        designTechnique: "Error Guessing (EG) — Duplicate entry scenario",
        testData: [
          { field: "First Name", value: "DupeTest",  note: "Used for initial record creation" },
          { field: "Last Name",  value: "DupeUser",  note: "Same value used in second attempt" },
          { field: "Employee ID", value: "DUP001",   note: "Unique identifier being duplicated" }
        ],
        steps: [
          `[Pre-condition] User is logged in as Admin.`,
          `Perform a successful ${subject}: Enter First Name "DupeTest", Last Name "DupeUser", save the record.`,
          `Note the generated employee ID or unique identifier: "DUP001".`,
          `Navigate back to the ${subject} form.`,
          `Attempt to create a second record with the exact same unique identifier "DUP001".`,
          `Click Save / Submit.`,
          `Observe the system response for the duplicate attempt.`,
          `Verify a duplicate-specific error message is displayed (e.g. "Employee ID already exists").`,
          `Verify only one record exists in the system for the tested identifier.`,
          `[Cleanup] Delete the test record created in step 2 if the system allows.`
        ],
        expected: `System detects the duplicate and displays a specific, actionable error message. No duplicate record is created in the database. The original record remains intact.`,
        priority: "Normal",
        tags: ["negative", "duplicate", "validation", "error-guessing"]
      };
    }
  },
  {
    build(subject) {
      return {
        title: `Verify ${subject} handles special characters and unicode`,
        description: `Test that text fields correctly accept or reject special characters and unicode input.`,
        designTechnique: "Error Guessing (EG) — Special character and encoding edge cases",
        testData: [
          { field: "First Name", value: "José",       note: "Accented unicode character — should be accepted" },
          { field: "First Name", value: "王",          note: "CJK unicode character — verify handling" },
          { field: "First Name", value: "O'Brien",    note: "Apostrophe — common SQL injection vector (EG)" },
          { field: "First Name", value: "Test–Name",  note: "En-dash unicode character" },
          { field: "Last Name",  value: "Müller",     note: "Umlaut unicode — should be accepted" }
        ],
        steps: [
          `[Pre-condition] User is logged in as Admin. Navigate to ${subject} form.`,
          `Enter First Name: "José" (unicode accented character). Submit and verify acceptance and correct storage/display.`,
          `Navigate back. Enter First Name: "O'Brien" (apostrophe). Submit and verify no SQL error occurs and data is stored correctly.`,
          `Navigate back. Enter Last Name: "Müller" (umlaut). Submit and verify the umlaut is preserved in the saved record.`,
          `Navigate back. Enter First Name: "王" (CJK character). Submit and observe system handling (accept or graceful reject).`,
          `For any accepted values: navigate to the employee profile and verify the displayed name matches exactly what was entered.`,
          `Verify no JavaScript errors, 500 errors, or database exceptions occur at any step.`
        ],
        expected: `Commonly accepted unicode (accented, umlaut) is stored and displayed correctly. Special chars like apostrophe are sanitised without causing injection. System never crashes or shows raw errors regardless of input.`,
        priority: "Normal",
        tags: ["edge-case", "special-characters", "unicode", "error-guessing"]
      };
    }
  },
  {
    build(subject) {
      return {
        title: `Verify UI feedback messages are correct for ${subject}`,
        description: `Ensure success and error messages are displayed correctly after each action.`,
        designTechnique: "Use Case / Scenario-based (UC) — UI response verification",
        testData: [
          { action: "Valid save",    expectedMsg: "Successfully Saved" },
          { action: "Validation fail", expectedMsg: "Required field error" },
          { action: "Server error",  expectedMsg: "Error or retry prompt" }
        ],
        steps: [
          `[Pre-condition] User is logged in as Admin. Navigate to ${subject} form.`,
          `[Positive] Complete a successful ${subject} with valid data (First Name: "UITest", Last Name: "User").`,
          `Verify the success toast / notification appears and reads "Successfully Saved" (or equivalent).`,
          `Verify the success message is visible for the expected duration, then disappears or has a dismiss option.`,
          `Verify the success message is free from spelling mistakes and grammatical errors.`,
          `[Negative] Submit the form with empty required fields.`,
          `Verify field-level error messages appear in red / highlighted styling.`,
          `Verify error messages are actionable (e.g. "First Name is required" not just "Error").`,
          `[Recovery] Fill valid data after seeing errors and re-submit.`,
          `Verify the form recovers cleanly, error messages clear, and success is shown.`
        ],
        expected: `Success messages are accurate, visible, and well-styled. Error messages are specific, actionable, and clear. The UI recovers correctly after error correction. No raw error codes or stack traces are shown to the user.`,
        priority: "Normal",
        tags: ["ui", "usability", "feedback", "use-case"]
      };
    }
  },
  {
    build(subject) {
      return {
        title: `Verify cancel or discard action during ${subject}`,
        description: `Ensure that cancelling mid-way through ${subject} does not save any partial data.`,
        designTechnique: "State Transition (ST) — In-progress → Cancelled transition",
        testData: [
          { field: "First Name", value: "CancelTest", note: "Partially entered — will be discarded" },
          { field: "Last Name",  value: "Partial",     note: "Partially entered — will be discarded" }
        ],
        steps: [
          `[Pre-condition] User is logged in as Admin. Navigate to ${subject} form.`,
          `[State: Form Empty] Verify the form starts in an empty state.`,
          `[State: Partially Filled] Enter First Name: "CancelTest" and Last Name: "Partial" without submitting.`,
          `Without clicking Save, click the Cancel button (or navigate away using the browser Back button).`,
          `[State: Cancelled] Observe what happens — browser may show an "unsaved changes" warning.`,
          `If a warning appears, confirm the discard action.`,
          `[State: Returned] Verify the user is returned to the previous page or employee list.`,
          `Navigate to the employee list and search for "CancelTest". Verify no partial record exists.`,
          `Verify zero data was persisted from the cancelled form entry.`
        ],
        expected: `No data from the in-progress form is saved after cancel. The user is returned to a previous stable state. If an "unsaved changes" warning appeared, it functioned correctly. Record list shows no partial entry.`,
        priority: "Low",
        tags: ["cancel", "negative", "data-integrity", "state-transition"]
      };
    }
  },
  {
    build(subject) {
      return {
        title: `Verify data is persisted correctly after ${subject}`,
        description: `Confirm that submitted data is accurately saved and can be retrieved.`,
        designTechnique: "State Transition (ST) — Created → Saved → Retrieved",
        testData: [
          { field: "First Name",  value: "PersistTest",  note: "Known value to verify after save" },
          { field: "Last Name",   value: "DataCheck",    note: "Known value to verify after save" },
          { field: "Middle Name", value: "Verify",       note: "Optional field to check persistence" }
        ],
        steps: [
          `[State: Pre-action] Count existing records before test (note the total).`,
          `Navigate to ${subject} form. Enter First Name: "PersistTest", Middle Name: "Verify", Last Name: "DataCheck".`,
          `Click Save. Verify success message appears.`,
          `[State: Record Created] Note the assigned employee ID or unique identifier.`,
          `Navigate away from the page to the employee list/dashboard.`,
          `[State: Navigated Away] Return to the employee list and search for "PersistTest".`,
          `Open the newly created record.`,
          `[State: Retrieved] Verify First Name = "PersistTest" (exact match, including case).`,
          `Verify Middle Name = "Verify" (exact match).`,
          `Verify Last Name = "DataCheck" (exact match).`,
          `Verify total record count increased by exactly 1 compared to pre-action count.`
        ],
        expected: `All submitted data (First Name, Middle Name, Last Name) is accurately stored. Retrieved values exactly match input values. Record count increases by 1. No data corruption or truncation occurs.`,
        priority: "High",
        tags: ["data-integrity", "persistence", "regression", "state-transition"]
      };
    }
  },
  {
    build(subject) {
      return {
        title: `Verify ${subject} with the maximum number of records`,
        description: `Test system performance and behaviour when approaching or at maximum data limits.`,
        designTechnique: "Boundary Value Analysis (BVA) — Volume / capacity boundary",
        testData: [
          { scenario: "Near limit",   recordCount: "100 records",  note: "Max-1 volume test" },
          { scenario: "At limit",     recordCount: "System max",   note: "Max volume test" },
          { scenario: "Over limit",   recordCount: "Max + 1",      note: "Max+1 — expect graceful error" }
        ],
        steps: [
          `[Pre-condition] Identify the system's maximum record limit for ${subject} (from documentation or config).`,
          `Create records up to near-maximum capacity (or use existing data if already near limit).`,
          `Attempt to perform ${subject} at the near-maximum threshold and verify normal behaviour.`,
          `Attempt to perform ${subject} at the exact maximum limit. Observe and document the response.`,
          `Attempt to perform ${subject} one record beyond the maximum limit.`,
          `Verify the system displays a meaningful limit-exceeded error message (not a crash or 500 error).`,
          `Verify system performance: page load, search, and save operations remain within acceptable time (< 5 seconds).`,
          `Verify the system does not create partial records or corrupt existing data at capacity boundary.`
        ],
        expected: `System handles maximum data load gracefully. Near-maximum and at-maximum operations succeed. Exceeding the limit triggers a clear, user-friendly error. Performance remains acceptable. No data corruption or system failure.`,
        priority: "Low",
        tags: ["performance", "boundary", "edge-case", "bva-volume"]
      };
    }
  }
];

// ── Design technique label helper ─────────────────────────────────────
function pickTechnique(tags) {
  if (tags.includes('bva'))               return 'Boundary Value Analysis (BVA)';
  if (tags.includes('ep-invalid'))        return 'Equivalence Partitioning (EP) — Invalid';
  if (tags.includes('ep-empty'))          return 'Equivalence Partitioning (EP) — Empty/Null';
  if (tags.includes('state-transition'))  return 'State Transition (ST)';
  if (tags.includes('error-guessing'))    return 'Error Guessing (EG)';
  if (tags.includes('use-case'))          return 'Use Case / Scenario (UC)';
  return 'Equivalence Partitioning (EP) — Valid';
}

// Keywords that activate a security/permissions test case
const SECURITY_KEYWORDS = ["role", "permission", "admin", "access", "authoris", "authoriz", "login", "password", "secure"];

async function generate(story, plan) {
  const fields  = story.fields || {};
  const summary = fields.summary || "story";
  const desc    = extractText(fields.description);
  const allText = `${summary} ${desc}`.toLowerCase();

  // Strip common Jira story filler to get a concise subject phrase
  const subject = summary
    .replace(/^(as a|i want to|so that|given|when|then|user story:|story:)\s*/i, "")
    .trim() || summary;

  // Derive applicable design techniques from the planner output
  const techniques = (plan && plan.designTechniques) || [];
  const techNote   = techniques.length > 0 ? `Techniques: ${techniques.join(', ')}` : '';

  const testCases = TEMPLATES.map(t => {
    const tc = t.build(subject);
    tc.gwt = stepsToGWT(tc.steps);
    return tc;
  });

  // Annotate each test case with planner technique context if available
  if (techNote) {
    testCases.forEach(tc => {
      if (!tc.designTechnique) tc.designTechnique = pickTechnique(tc.tags || []);
      tc.plannerTechniques = techniques;
    });
  }

  // Conditionally add a security / RBAC test case
  if (SECURITY_KEYWORDS.some(k => allText.includes(k))) {
    const rbacTc = {
      title: `Verify role-based access control for ${subject}`,
      description: `Ensure only authorised roles can perform ${subject}. Uses Decision Table technique across role combinations.`,
      designTechnique: "Decision Table (DT) — Role × Permission matrix",
      testData: [
        { role: "Admin",          canPerform: true,  expectedResult: "Action succeeds" },
        { role: "ESS User",       canPerform: false, expectedResult: "Access denied / redirect" },
        { role: "Supervisor",     canPerform: false, expectedResult: "Access denied / redirect" },
        { role: "Not logged in",  canPerform: false, expectedResult: "Redirect to login" }
      ],
      steps: [
        `[Pre-condition] Identify all roles relevant to ${subject} (Admin, ESS User, Supervisor).`,
        `Log in as a user with the Admin role. Attempt to perform ${subject}. Verify the action succeeds.`,
        `Log out. Log in as an ESS User (no admin rights). Navigate to ${subject} page.`,
        `Verify the action is blocked — either the URL redirects, the button is disabled, or an "Access Denied" message shows.`,
        `Log out. Log in as a Supervisor role. Attempt the same action. Verify blocked as per role matrix.`,
        `Access the URL directly without being logged in — verify redirect to login page.`,
        `[Post-condition] Confirm no unauthorised actions were recorded in the system audit log.`
      ],
      expected: `Only Admin can perform ${subject}. All other roles are denied with a clear, appropriate message. No privilege escalation is possible.`,
      priority: "High",
      tags: ["security", "authorization", "rbac", "decision-table"]
    };
    rbacTc.gwt = stepsToGWT(rbacTc.steps);
    testCases.push(rbacTc);
  }

  // Add acceptance-criteria test case if present in the story
  const ac = extractText(fields.customfield_10016) || extractText(fields.customfield_10014);
  if (ac && ac.trim().length > 10) {
    const acTc = {
      title: `Verify all acceptance criteria are met for ${subject}`,
      description: `End-to-end validation of the story against its defined acceptance criteria using Use Case / Scenario technique.`,
      designTechnique: "Use Case / Scenario-based (UC) — Acceptance Criteria validation",
      testData: [
        { criterion: ac.slice(0, 200), note: "As defined in the story" }
      ],
      steps: [
        `Review the acceptance criteria for the story: "${ac.slice(0, 200)}"`,
        `Map each acceptance criterion to a specific test condition and expected outcome.`,
        `Execute each acceptance criterion sequentially as an end-to-end scenario.`,
        `For each criterion: record Actual Result, compare to Expected, mark Pass/Fail.`,
        `Verify all acceptance criteria are satisfied simultaneously (no partial pass).`
      ],
      expected: `All acceptance criteria defined in the story are satisfied. Each criterion maps to a passing test condition.`,
      priority: "High",
      tags: ["acceptance-criteria", "regression", "use-case"]
    };
    acTc.gwt = stepsToGWT(acTc.steps);
    testCases.push(acTc);
  }

  // ── Dynamic test generation (contextual gap analysis) ──────────────
  const dynamicCases = generateDynamicTestCases(story, plan, subject, testCases);
  if (dynamicCases.length > 0) {
    logger.info(`Dynamic generator produced ${dynamicCases.length} additional test case(s)`);
    testCases.push(...dynamicCases);
  }

  // ── Fallback: low planner confidence → ensure minimal safety net ──
  // If the planner signalled low confidence (< AGENT_CONFIDENCE_THRESHOLD) OR
  // the template/dynamic generators somehow produced nothing, we must still
  // emit at least one Happy Path, one Negative and one Boundary test case.
  const confThreshold = parseFloat(process.env.AGENT_CONFIDENCE_THRESHOLD || '0.4');
  const plannerConfidence = (plan && typeof plan.confidence === 'number') ? plan.confidence : 1;
  const lowConfidence = plannerConfidence < confThreshold;

  const hasTag = (tag) => testCases.some(tc => (tc.tags || []).includes(tag));
  if (lowConfidence || testCases.length === 0) {
    logger.warn(`QA: planner confidence ${plannerConfidence} below threshold ${confThreshold} — injecting safety-net test cases`);
    if (!hasTag('happy-path')) {
      testCases.push({
        title: `[Fallback] Verify ${subject} completes successfully with valid inputs`,
        description: `Safety-net happy-path test generated due to low planner confidence (${plannerConfidence}).`,
        designTechnique: 'Equivalence Partitioning (EP) — Valid partition',
        steps: [
          `[Pre-condition] User is authenticated with sufficient permissions.`,
          `Navigate to the ${subject} entry point.`,
          `Provide all required inputs with valid data.`,
          `Submit the action and observe the system response.`,
          `Verify the success path is reached without errors.`
        ],
        expected: `The ${subject} operation completes successfully; success feedback is shown; data is persisted.`,
        priority: 'High',
        tags: ['happy-path', 'smoke', 'fallback']
      });
    }
    if (!hasTag('negative')) {
      testCases.push({
        title: `[Fallback] Verify ${subject} rejects invalid inputs gracefully`,
        description: `Safety-net negative test generated due to low planner confidence.`,
        designTechnique: 'Error Guessing (EG)',
        steps: [
          `[Pre-condition] User is authenticated.`,
          `Navigate to the ${subject} entry point.`,
          `Provide invalid or malformed inputs (e.g. empty fields, special characters, overlong strings).`,
          `Submit and verify validation errors are shown without any server crash.`,
          `Verify no partial record or side effect is persisted.`
        ],
        expected: `The system displays clear validation errors, prevents submission, and does not persist invalid data.`,
        priority: 'High',
        tags: ['negative', 'fallback']
      });
    }
    if (!hasTag('boundary') && !hasTag('bva')) {
      testCases.push({
        title: `[Fallback] Verify ${subject} handles boundary values correctly`,
        description: `Safety-net boundary test generated due to low planner confidence.`,
        designTechnique: 'Boundary Value Analysis (BVA)',
        steps: [
          `[Pre-condition] User is authenticated.`,
          `Identify an input with a documented numeric or length boundary.`,
          `Submit with value at the lower boundary and verify acceptance.`,
          `Submit with value at the upper boundary and verify acceptance.`,
          `Submit with value one beyond the upper boundary and verify rejection.`
        ],
        expected: `Boundary-valid values are accepted and just-over-boundary values are rejected with a clear message.`,
        priority: 'Normal',
        tags: ['boundary', 'bva', 'fallback']
      });
    }
  }

  // Attach GWT to any cases added after the initial map (e.g. fallback ones)
  testCases.forEach(tc => {
    if (!Array.isArray(tc.gwt) || tc.gwt.length === 0) {
      tc.gwt = stepsToGWT(tc.steps || []);
    }
  });

  // ── Schema validation (non-throwing: sanitise on failure) ─────────
  let output = testCases;
  const { valid, errors } = validateQAOutput(output);
  if (!valid) {
    logger.warn(`QA output failed schema validation: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? '…' : ''} — sanitising`);
    output = sanitizeQAOutput(output);
  }

  // ── Decision log ──────────────────────────────────────────────────
  const priorityCount = output.reduce((acc, tc) => {
    acc[tc.priority] = (acc[tc.priority] || 0) + 1; return acc;
  }, {});
  logDecision('qa', {
    storyKey:  story.key || null,
    title:     fields.summary || null,
    wordCount: allText.trim().split(/\s+/).length
  }, {
    testCaseCount:  output.length,
    priorityCount,
    fallbackApplied: lowConfidence || testCases.length === 0
  }, {
    plannerConfidence,
    confidenceThreshold: confThreshold,
    techniquesApplied: techniques
  });

  return output;
}

// ── Dynamic Test Case Generator (rule-based gap analysis) ────────────
// Each pattern detects a story context and produces test cases that the static
// templates do NOT cover — domain-specific, integration, concurrency, etc.
const DYNAMIC_PATTERNS = [
  {
    // Session / timeout / concurrency scenarios for auth flows
    match: /login|auth|sign.?in|session/i,
    excludeTag: "session",
    build(subject) {
      return {
        title: `Verify session timeout and re-authentication for ${subject}`,
        description: `Ensure the system enforces session expiry after inactivity and requires re-authentication.`,
        designTechnique: "State Transition (ST) — Active → Expired → Re-auth",
        testData: [
          { scenario: "Idle 15+ minutes", expectedResult: "Session expired, redirect to login" },
          { scenario: "Active within timeout", expectedResult: "Session remains active" }
        ],
        steps: [
          `[Pre-condition] User is logged in as Admin. Note the current time.`,
          `Leave the application idle without any interaction for the configured session timeout period.`,
          `After the timeout period, attempt to navigate to a protected page or perform an action.`,
          `Verify the system redirects to the login page or shows a "Session Expired" message.`,
          `Log in again with valid credentials and verify the session resumes cleanly.`,
          `Verify no partial actions were committed during the expired session.`
        ],
        expected: `Session expires after the configured timeout. User is redirected to login. No data is lost or corrupted. Re-authentication works seamlessly.`,
        priority: "High",
        tags: ["session", "security", "state-transition", "dynamic-generated"]
      };
    }
  },
  {
    // Concurrent access scenario
    match: /create|add|save|submit|update|edit/i,
    excludeTag: "concurrency",
    build(subject) {
      return {
        title: `Verify concurrent access handling for ${subject}`,
        description: `Ensure the system handles simultaneous ${subject} operations from multiple users without data corruption.`,
        designTechnique: "Error Guessing (EG) — Concurrency / race condition",
        testData: [
          { scenario: "Two users submit same form simultaneously", expectedResult: "One succeeds, other gets conflict error or both succeed without corruption" }
        ],
        steps: [
          `[Pre-condition] Open two separate browser sessions, both logged in as different users.`,
          `In browser 1: navigate to the ${subject} form and fill in all required fields.`,
          `In browser 2: navigate to the same ${subject} form and fill in all required fields with different data.`,
          `Submit both forms as close to simultaneously as possible.`,
          `Verify no server errors (500), crashes, or data corruption occur.`,
          `Verify both records are created correctly with their respective data, or one receives a meaningful conflict error.`,
          `Check the database / list view to ensure no duplicate or merged records exist.`
        ],
        expected: `System handles concurrent submissions gracefully. Either both succeed independently or the second submission receives a clear error. No data corruption or lost updates.`,
        priority: "Normal",
        tags: ["concurrency", "edge-case", "error-guessing", "dynamic-generated"]
      };
    }
  },
  {
    // Keyboard / accessibility scenario for form-based stories
    match: /form|field|input|page|screen|ui/i,
    excludeTag: "accessibility",
    build(subject) {
      return {
        title: `Verify keyboard navigation and accessibility for ${subject}`,
        description: `Ensure all interactive elements are keyboard-accessible and screen-reader friendly for ${subject}.`,
        designTechnique: "Use Case / Scenario-based (UC) — Accessibility compliance",
        testData: [
          { element: "Form fields", expected: "Tab-navigable in logical order" },
          { element: "Submit button", expected: "Reachable via Tab, activatable via Enter" },
          { element: "Error messages", expected: "Announced by screen reader" }
        ],
        steps: [
          `[Pre-condition] User is logged in. Navigate to the ${subject} page.`,
          `Without using the mouse, press Tab repeatedly to navigate through all form fields.`,
          `Verify the tab order follows a logical top-to-bottom, left-to-right sequence.`,
          `Verify each focused element has a visible focus indicator (outline or highlight).`,
          `Navigate to the Submit/Save button using Tab and press Enter to submit.`,
          `Verify the form submits successfully via keyboard alone.`,
          `Trigger a validation error and verify the error message is associated with the field (aria-describedby or similar).`
        ],
        expected: `All form elements are reachable via keyboard. Tab order is logical. Focus indicators are visible. Error messages are programmatically associated with fields. No mouse-only interactions required.`,
        priority: "Normal",
        tags: ["accessibility", "usability", "use-case", "dynamic-generated"]
      };
    }
  },
  {
    // Back/forward browser navigation
    match: /form|save|submit|create|add/i,
    excludeTag: "browser-navigation",
    build(subject) {
      return {
        title: `Verify browser back/forward navigation during ${subject}`,
        description: `Ensure the application handles browser navigation buttons correctly during the ${subject} flow.`,
        designTechnique: "State Transition (ST) — Navigation state recovery",
        testData: [
          { action: "Browser Back after submit", expectedResult: "No duplicate submission" },
          { action: "Browser Back mid-form", expectedResult: "Form data may be lost, no crash" }
        ],
        steps: [
          `[Pre-condition] User is logged in as Admin. Navigate to ${subject} form.`,
          `Fill in all required fields with valid data but do NOT submit.`,
          `Click the browser Back button. Then click browser Forward button.`,
          `Verify the form reloads without errors (data may or may not be preserved).`,
          `Fill the form again and click Submit. Verify success.`,
          `Immediately click the browser Back button after successful submission.`,
          `Verify the system does NOT re-submit the form (no duplicate record created).`,
          `Click browser Forward button and verify the confirmation/list page loads correctly.`
        ],
        expected: `Browser navigation does not cause duplicate submissions, crashes, or unhandled errors. The user can navigate back and forward without corrupting application state.`,
        priority: "Normal",
        tags: ["browser-navigation", "state-transition", "edge-case", "dynamic-generated"]
      };
    }
  },
  {
    // Network / slow response scenario
    match: /save|submit|create|upload|api/i,
    excludeTag: "network-resilience",
    build(subject) {
      return {
        title: `Verify system resilience under slow network for ${subject}`,
        description: `Ensure the application handles slow or interrupted network conditions gracefully during ${subject}.`,
        designTechnique: "Error Guessing (EG) — Network failure scenario",
        testData: [
          { condition: "Slow network (3G)", expectedResult: "Loading indicator shown, operation completes or times out gracefully" },
          { condition: "Double-click submit", expectedResult: "Only one record created" }
        ],
        steps: [
          `[Pre-condition] User is logged in. Navigate to ${subject} form. Open browser DevTools and throttle network to Slow 3G.`,
          `Fill in all required fields and click Submit.`,
          `Verify a loading indicator (spinner, disabled button) appears during the request.`,
          `Verify the submit button is disabled to prevent double-click submission.`,
          `Wait for the response — verify it either succeeds or shows a timeout/error message.`,
          `Reset network to normal. Verify only one record was created (no duplicates from retry).`,
          `[Edge case] Disconnect network mid-submission and verify the system shows an appropriate offline/error message.`
        ],
        expected: `Loading indicator prevents user confusion. Double-submit is prevented. Timeout shows a clear error. Reconnection allows retry without data duplication.`,
        priority: "Low",
        tags: ["network-resilience", "error-guessing", "performance", "dynamic-generated"]
      };
    }
  },
  {
    // Clipboard/paste scenario for data input
    match: /input|field|form|enter|data/i,
    excludeTag: "clipboard-paste",
    build(subject) {
      return {
        title: `Verify copy-paste and autofill behaviour for ${subject}`,
        description: `Ensure fields handle pasted content (including hidden characters) and browser autofill correctly.`,
        designTechnique: "Error Guessing (EG) — Clipboard and autofill edge cases",
        testData: [
          { input: "Pasted text with leading/trailing whitespace", expected: "Trimmed or accepted without error" },
          { input: "Pasted text with newlines", expected: "Newlines stripped for single-line fields" },
          { input: "Browser autofill", expected: "Fields populated, validation still applies" }
        ],
        steps: [
          `[Pre-condition] User is logged in. Navigate to ${subject} form.`,
          `Copy text with leading/trailing spaces from an external source and paste into the First Name field.`,
          `Verify the system either trims the whitespace or accepts it without breaking validation.`,
          `Copy multi-line text and paste into a single-line field (e.g. Last Name).`,
          `Verify newline characters are stripped and the field shows clean single-line text.`,
          `Allow or trigger browser autofill for the form fields.`,
          `Verify autofilled values are recognized by form validation and do not bypass required-field checks.`
        ],
        expected: `Pasted content is handled gracefully — whitespace trimmed, newlines stripped from single-line fields. Browser autofill works correctly and validation still applies.`,
        priority: "Low",
        tags: ["clipboard-paste", "edge-case", "error-guessing", "dynamic-generated"]
      };
    }
  }
];

function generateDynamicTestCases(story, plan, subject, existingCases) {
  const fields = story.fields || {};
  const summary = fields.summary || "";
  const description = extractText(fields.description);
  const allText = `${summary} ${description}`.toLowerCase();

  const existingTags = new Set(existingCases.flatMap(tc => tc.tags || []));
  const existingTitlesLower = new Set(existingCases.map(tc => (tc.title || "").toLowerCase()));

  const dynamicCases = [];

  for (const pattern of DYNAMIC_PATTERNS) {
    // Skip if the story text doesn't match this pattern's context
    if (!pattern.match.test(allText)) continue;
    // Skip if existing TCs already cover this category
    if (existingTags.has(pattern.excludeTag)) continue;

    const tc = pattern.build(subject);
    // Final dedup check against existing titles
    if (existingTitlesLower.has(tc.title.toLowerCase())) continue;

    tc.gwt = stepsToGWT(tc.steps);
    dynamicCases.push(tc);
  }

  return dynamicCases;
}

module.exports = { generate, stepsToGWT };
