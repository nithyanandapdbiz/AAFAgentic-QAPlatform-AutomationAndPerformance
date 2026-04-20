'use strict';
/**
 * AddEmployeePage — OrangeHRM PIM → Add Employee
 * URL: /web/index.php/pim/addEmployee
 * Locators: AddEmployeePage.yml
 */
const path = require('path');
const { loadLocators } = require('../helpers/locatorLoader');
const loc = loadLocators(path.join(__dirname, 'AddEmployeePage.yml'));

class AddEmployeePage {
  constructor(page) {
    this.page = page;

    // ── Locators (from AddEmployeePage.yml) ──────────────────
    this.firstNameInput  = page.locator(loc.firstNameInput);
    this.middleNameInput = page.locator(loc.middleNameInput);
    this.lastNameInput   = page.locator(loc.lastNameInput);
    this.employeeIdInput = page.locator(loc.employeeIdInput);
    this.saveButton      = page.locator(loc.saveButton);
    this.cancelButton    = page.locator(loc.cancelButton);
    this.validationErrors = page.locator(loc.validationErrors);
  }

  // ── Actions ───────────────────────────────────────────────

  /** Navigate to the Add Employee form. */
  async navigate() {
    await this.page.goto('/web/index.php/pim/addEmployee');
    await this.page.waitForSelector(loc.firstNameInput, { timeout: 15000 });
  }

  /**
   * Fill the employee name form.
   * @param {object} opts
   * @param {string} opts.firstName
   * @param {string} [opts.middleName]
   * @param {string} opts.lastName
   */
  async fillEmployee({ firstName, middleName = '', lastName }) {
    await this.firstNameInput.fill(firstName);
    if (middleName) await this.middleNameInput.fill(middleName);
    await this.lastNameInput.fill(lastName);
  }

  /**
   * Overwrite the auto-generated Employee ID with a specific value.
   * @param {string} id
   */
  async setEmployeeId(id) {
    await this.employeeIdInput.waitFor({ state: 'visible', timeout: 5000 });
    await this.employeeIdInput.fill('');
    await this.employeeIdInput.fill(id);
  }

  /** Click the Save button. */
  async save() {
    await this.saveButton.click();
  }

  /**
   * Click Cancel if it exists; otherwise navigate away to the Employee List.
   */
  async cancel() {
    const visible = await this.cancelButton.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      await this.cancelButton.click();
    } else {
      await this.page.goto('/web/index.php/pim/viewEmployeeList');
    }
  }
}

module.exports = { AddEmployeePage };
