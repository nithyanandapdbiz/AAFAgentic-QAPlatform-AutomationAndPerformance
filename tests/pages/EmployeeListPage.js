'use strict';
/**
 * EmployeeListPage — OrangeHRM PIM → Employee List
 * URL: /web/index.php/pim/viewEmployeeList
 * Locators: EmployeeListPage.yml
 */
const path = require('path');
const { loadLocators } = require('../helpers/locatorLoader');
const loc = loadLocators(path.join(__dirname, 'EmployeeListPage.yml'));

class EmployeeListPage {
  constructor(page) {
    this.page = page;

    // ── Locators (from EmployeeListPage.yml) ─────────────────
    this.searchNameInput = page.locator(loc.searchNameInput).first();
    this.searchButton    = page.locator(loc.searchButton);
    this.tableRows       = page.locator(loc.tableRows);
    this.noRecordsText   = page.locator(loc.noRecordsText);
    this.paginationInfo  = page.locator(loc.paginationInfo);
  }

  // ── Actions ───────────────────────────────────────────────

  /** Navigate to the Employee List page. */
  async navigate() {
    await this.page.goto('/web/index.php/pim/viewEmployeeList');
    await this.page.waitForLoadState('domcontentloaded');
  }

  /**
   * Type a name into the search field and submit.
   * Uses a slight delay to trigger autocomplete suggestions.
   * @param {string} name  Full or partial employee name
   */
  async searchEmployee(name) {
    await this.navigate();
    await this.searchNameInput.click();
    await this.searchNameInput.type(name, { delay: 80 });
    await this.page.waitForResponse(
      resp => resp.url().includes('/api/') && resp.status() === 200,
      { timeout: 5000 }
    ).catch(() => {}); // fallback if no API call fires
    await this.searchButton.click();
    await this.page.waitForLoadState('domcontentloaded');
  }

  /** Returns the number of rows currently visible in the results table. */
  async getRowCount() {
    return this.tableRows.count();
  }
}

module.exports = { EmployeeListPage };
