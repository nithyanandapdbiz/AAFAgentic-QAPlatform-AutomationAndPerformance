# =============================================================================
# Module           : Login
# Story            : SCRUM-6 — User Login to OrangeHRM Application
# Test Cases       : SCRUM-T57 through SCRUM-T69
# Auto-generated   : run-story.js → Zephyr → Cucumber (GWT)
# =============================================================================

Feature: User Login to OrangeHRM Application

  Background:
    Given the browser is open at the OrangeHRM application

  # ─── Duplicate Prevention ─────────────────────────────────────────

  @SCRUM-T57 @negative @duplicate @validation @error-guessing
  Scenario: Verify duplicate User Login to OrangeHRM Application is prevented
    Given [Pre-condition] User is logged in as Admin.
    When Perform a successful User Login to OrangeHRM Application: Enter First Name "DupeTest", Last Name "DupeUser", save the record.
    And Note the generated employee ID or unique identifier: "DUP001".
    Given Navigate back to the User Login to OrangeHRM Application form.
    When Attempt to create a second record with the exact same unique identifier "DUP001".
    When Click Save / Submit.
    When Observe the system response for the duplicate attempt.
    Then Verify a duplicate-specific error message is displayed (e.g. "Employee ID already exists").
    Then Verify only one record exists in the system for the tested identifier.
    And [Cleanup] Delete the test record created in step 2 if the system allows.

  # ─── Validation — Invalid Input ───────────────────────────────────

  @SCRUM-T64 @session @security @state-transition @dynamic-generated
  Scenario: Verify session timeout and re-authentication for User Login to OrangeHRM Application
    Given [Pre-condition] User is logged in as Admin. Note the current time.
    When Leave the application idle without any interaction for the configured session timeout period.
    When After the timeout period, attempt to navigate to a protected page or perform an action.
    Then Verify the system redirects to the login page or shows a "Session Expired" message.
    Then Log in again with valid credentials and verify the session resumes cleanly.
    Then Verify no partial actions were committed during the expired session.

  @SCRUM-T63 @security @authorization @rbac @decision-table
  Scenario: Verify role-based access control for User Login to OrangeHRM Application
    Given [Pre-condition] Identify all roles relevant to User Login to OrangeHRM Application (Admin, ESS User, Supervisor).
    Then Log in as a user with the Admin role. Attempt to perform User Login to OrangeHRM Application. Verify the action succeeds.
    Given Log out. Log in as an ESS User (no admin rights). Navigate to User Login to OrangeHRM Application page.
    Then Verify the action is blocked — either the URL redirects, the button is disabled, or an "Access Denied" message shows.
    Then Log out. Log in as a Supervisor role. Attempt the same action. Verify blocked as per role matrix.
    Then Access the URL directly without being logged in — verify redirect to login page.
    Then [Post-condition] Confirm no unauthorised actions were recorded in the system audit log.

  # ─── General ──────────────────────────────────────────────────────

  @SCRUM-T65 @concurrency @edge-case @error-guessing @dynamic-generated
  Scenario: Verify concurrent access handling for User Login to OrangeHRM Application
    Given [Pre-condition] Open two separate browser sessions, both logged in as different users.
    Given In browser 1: navigate to the User Login to OrangeHRM Application form and fill in all required fields.
    Given In browser 2: navigate to the same User Login to OrangeHRM Application form and fill in all required fields with different data.
    When Submit both forms as close to simultaneously as possible.
    Then Verify no server errors (500), crashes, or data corruption occur.
    Then Verify both records are created correctly with their respective data, or one receives a meaningful conflict error.
    Then Check the database / list view to ensure no duplicate or merged records exist.

  @SCRUM-T66 @browser-navigation @state-transition @edge-case @dynamic-generated
  Scenario: Verify browser back/forward navigation during User Login to OrangeHRM Application
    Given [Pre-condition] User is logged in as Admin. Navigate to User Login to OrangeHRM Application form.
    When Fill in all required fields with valid data but do NOT submit.
    When Click the browser Back button. Then click browser Forward button.
    Then Verify the form reloads without errors (data may or may not be preserved).
    Then Fill the form again and click Submit. Verify success.
    When Immediately click the browser Back button after successful submission.
    Then Verify the system does NOT re-submit the form (no duplicate record created).
    Then Click browser Forward button and verify the confirmation/list page loads correctly.

  @SCRUM-T67 @clipboard-paste @edge-case @error-guessing @dynamic-generated
  Scenario: Verify copy-paste and autofill behaviour for User Login to OrangeHRM Application
    Given [Pre-condition] User is logged in. Navigate to User Login to OrangeHRM Application form.
    When Copy text with leading/trailing spaces from an external source and paste into the First Name field.
    Then Verify the system either trims the whitespace or accepts it without breaking validation.
    And Copy multi-line text and paste into a single-line field (e.g. Last Name).
    Then Verify newline characters are stripped and the field shows clean single-line text.
    When Allow or trigger browser autofill for the form fields.
    Then Verify autofilled values are recognized by form validation and do not bypass required-field checks.

  # ─── Happy Path ───────────────────────────────────────────────────

  @SCRUM-T53 @happy-path @smoke @ep-valid
  Scenario: Verify successful User Login to OrangeHRM Application with valid inputs
    Given [Pre-condition] User is logged out. Browser is open at the application URL.
    Given Navigate to the application login page and log in with valid admin credentials (Username: Admin, Password: admin123).
    Given Navigate to the User Login to OrangeHRM Application page or form via the main navigation menu.
    Then Verify the form/page loads completely with all fields visible.
    When Fill in First Name field with valid test data: "AutoTest" (alphabetic, within 1–50 char limit).
    When Fill in Last Name field with valid test data: "Employee" (alphabetic, within 1–50 char limit).
    When Fill in any other required fields with valid test data as per test data table.
    When Click the Save / Submit button to trigger the action.
    And Wait for the system response (success message or redirect).
    Then Verify a success confirmation message is displayed (e.g. "Successfully Saved").
    Then Verify the system redirects to the expected page (e.g. employee detail view).
    Then [Post-condition] Verify the new record appears in the list/search results.

  @SCRUM-T55 @negative @invalid-data @validation @ep-invalid @security-eg
  Scenario: Verify User Login to OrangeHRM Application rejects invalid input data
    Given [Pre-condition] User is logged in as Admin. Navigate to User Login to OrangeHRM Application form.
    When Enter numeric-only value "12345" in the First Name field.
    When Enter special characters "!@#$%^&*" in the Last Name field.
    When Click Save / Submit and observe any validation errors shown.
    When Clear the fields and enter HTML injection attempt "<script>alert(1)</script>" in First Name.
    Then Click Save / Submit and verify the system handles this without executing script.
    When Clear the fields and enter a value with spaces "John Doe Smith" in a username-type field.
    Then Submit and observe system response (expect validation error or sanitised output).
    Then Verify no system crash, 500 error, or unhandled exception occurs at any point.
    Then [Post-condition] Confirm no invalid records were persisted in the database.

  # ─── Validation — Mandatory Fields ────────────────────────────────

  @SCRUM-T54 @validation @negative @required-fields @ep-empty
  Scenario: Verify mandatory fields are enforced for User Login to OrangeHRM Application
    Given [Pre-condition] User is logged in as Admin.
    Given Navigate to the User Login to OrangeHRM Application page or form.
    When Leave the First Name field completely empty (do not enter any value).
    When Leave the Last Name field completely empty (do not enter any value).
    And Leave any other mandatory fields empty.
    When Click the Save / Submit button without filling any required fields.
    And Observe all inline validation messages that appear below each empty field.
    Then Verify the form does NOT submit (URL remains on the form page).
    Then Verify the First Name field shows an error message (e.g. "Required").
    Then Verify the Last Name field shows an error message (e.g. "Required").
    Then [Negative check] Verify no partial record is created in the system.

  # ─── Boundary Value Analysis ──────────────────────────────────────

  @SCRUM-T56 @boundary @edge-case @bva
  Scenario: Verify boundary values are handled correctly for User Login to OrangeHRM Application
    Given [Pre-condition] User is logged in as Admin. Navigate to User Login to OrangeHRM Application form.
    Then [BVA-1] Enter minimum boundary value: single character "A" in First Name and "B" in Last Name. Submit and verify the form accepts it.
    Then [BVA-2] Enter Min+1 boundary value: two characters "AB" in First Name. Submit and verify acceptance.
    Then [BVA-3] Navigate back and enter Max-1 boundary value: 49-character string in First Name. Submit and verify acceptance.
    Then [BVA-4] Navigate back and enter the exact maximum boundary: 50-character string in First Name. Submit and verify acceptance.
    Then [BVA-5] Navigate back and enter Max+1 boundary: 51-character string in First Name. Submit and verify rejection with error message.
    And Record actual system behaviour for each boundary point in a table.
    Then Verify that accepted boundary values are correctly persisted and displayed.

  @SCRUM-T62 @performance @boundary @edge-case @bva-volume
  Scenario: Verify User Login to OrangeHRM Application with the maximum number of records
    Given [Pre-condition] Identify the system's maximum record limit for User Login to OrangeHRM Application (from documentation or config).
    When Create records up to near-maximum capacity (or use existing data if already near limit).
    Then Attempt to perform User Login to OrangeHRM Application at the near-maximum threshold and verify normal behaviour.
    When Attempt to perform User Login to OrangeHRM Application at the exact maximum limit. Observe and document the response.
    When Attempt to perform User Login to OrangeHRM Application one record beyond the maximum limit.
    Then Verify the system displays a meaningful limit-exceeded error message (not a crash or 500 error).
    Then Verify system performance: page load, search, and save operations remain within acceptable time (< 5 seconds).
    Then Verify the system does not create partial records or corrupt existing data at capacity boundary.

  # ─── Special Characters & Unicode ─────────────────────────────────

  @SCRUM-T58 @edge-case @special-characters @unicode @error-guessing
  Scenario: Verify User Login to OrangeHRM Application handles special characters and unicode
    Given [Pre-condition] User is logged in as Admin. Navigate to User Login to OrangeHRM Application form.
    Then Enter First Name: "José" (unicode accented character). Submit and verify acceptance and correct storage/display.
    Then Navigate back. Enter First Name: "O'Brien" (apostrophe). Submit and verify no SQL error occurs and data is stored correctly.
    Then Navigate back. Enter Last Name: "Müller" (umlaut). Submit and verify the umlaut is preserved in the saved record.
    When Navigate back. Enter First Name: "王" (CJK character). Submit and observe system handling (accept or graceful reject).
    Then For any accepted values: navigate to the employee profile and verify the displayed name matches exactly what was entered.
    Then Verify no JavaScript errors, 500 errors, or database exceptions occur at any step.

  # ─── Cancel / Discard ─────────────────────────────────────────────

  @SCRUM-T60 @cancel @negative @data-integrity @state-transition
  Scenario: Verify cancel or discard action during User Login to OrangeHRM Application
    Given [Pre-condition] User is logged in as Admin. Navigate to User Login to OrangeHRM Application form.
    Then [State: Form Empty] Verify the form starts in an empty state.
    When [State: Partially Filled] Enter First Name: "CancelTest" and Last Name: "Partial" without submitting.
    When Without clicking Save, click the Cancel button (or navigate away using the browser Back button).
    And [State: Cancelled] Observe what happens — browser may show an "unsaved changes" warning.
    Then If a warning appears, confirm the discard action.
    Then [State: Returned] Verify the user is returned to the previous page or employee list.
    Then Navigate to the employee list and search for "CancelTest". Verify no partial record exists.
    Then Verify zero data was persisted from the cancelled form entry.

  # ─── Data Persistence ─────────────────────────────────────────────

  @SCRUM-T61 @data-integrity @persistence @regression @state-transition
  Scenario: Verify data is persisted correctly after User Login to OrangeHRM Application
    Given [State: Pre-action] Count existing records before test (note the total).
    Given Navigate to User Login to OrangeHRM Application form. Enter First Name: "PersistTest", Middle Name: "Verify", Last Name: "DataCheck".
    Then Click Save. Verify success message appears.
    And [State: Record Created] Note the assigned employee ID or unique identifier.
    And Navigate away from the page to the employee list/dashboard.
    When [State: Navigated Away] Return to the employee list and search for "PersistTest".
    When Open the newly created record.
    Then [State: Retrieved] Verify First Name = "PersistTest" (exact match, including case).
    Then Verify Middle Name = "Verify" (exact match).
    Then Verify Last Name = "DataCheck" (exact match).
    Then Verify total record count increased by exactly 1 compared to pre-action count.

  # ─── Performance / Volume ─────────────────────────────────────────

  @SCRUM-T68 @network-resilience @error-guessing @performance @dynamic-generated
  Scenario: Verify system resilience under slow network for User Login to OrangeHRM Application
    Given [Pre-condition] User is logged in. Navigate to User Login to OrangeHRM Application form. Open browser DevTools and throttle network to Slow 3G.
    When Fill in all required fields and click Submit.
    Then Verify a loading indicator (spinner, disabled button) appears during the request.
    Then Verify the submit button is disabled to prevent double-click submission.
    Then Wait for the response — verify it either succeeds or shows a timeout/error message.
    Then Reset network to normal. Verify only one record was created (no duplicates from retry).
    Then [Edge case] Disconnect network mid-submission and verify the system shows an appropriate offline/error message.

  # ─── UI Feedback ──────────────────────────────────────────────────

  @SCRUM-T59 @ui @usability @feedback @use-case
  Scenario: Verify UI feedback messages are correct for User Login to OrangeHRM Application
    Given [Pre-condition] User is logged in as Admin. Navigate to User Login to OrangeHRM Application form.
    When [Positive] Complete a successful User Login to OrangeHRM Application with valid data (First Name: "UITest", Last Name: "User").
    Then Verify the success toast / notification appears and reads "Successfully Saved" (or equivalent).
    Then Verify the success message is visible for the expected duration, then disappears or has a dismiss option.
    Then Verify the success message is free from spelling mistakes and grammatical errors.
    When [Negative] Submit the form with empty required fields.
    Then Verify field-level error messages appear in red / highlighted styling.
    Then Verify error messages are actionable (e.g. "First Name is required" not just "Error").
    When [Recovery] Fill valid data after seeing errors and re-submit.
    Then Verify the form recovers cleanly, error messages clear, and success is shown.

  @SCRUM-T69 @accessibility @usability @use-case @dynamic-generated
  Scenario: Verify keyboard navigation and accessibility for User Login to OrangeHRM Application
    Given [Pre-condition] User is logged in. Navigate to the User Login to OrangeHRM Application page.
    When Without using the mouse, press Tab repeatedly to navigate through all form fields.
    Then Verify the tab order follows a logical top-to-bottom, left-to-right sequence.
    Then Verify each focused element has a visible focus indicator (outline or highlight).
    When Navigate to the Submit/Save button using Tab and press Enter to submit.
    Then Verify the form submits successfully via keyboard alone.
    Then Trigger a validation error and verify the error message is associated with the field (aria-describedby or similar).
