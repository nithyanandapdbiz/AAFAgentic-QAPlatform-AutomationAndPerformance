'use strict';
/**
 * LoginPage — OrangeHRM Login
 * URL: /web/index.php/auth/login
 * Locators: LoginPage.yml
 */
const path = require('path');
const { loadLocators } = require('../helpers/locatorLoader');
const loc = loadLocators(path.join(__dirname, 'LoginPage.yml'));

class LoginPage {
  constructor(page) {
    this.page = page;

    // ── Locators (from LoginPage.yml) ──────────────────────
    this.usernameInput = page.locator(loc.usernameInput);
    this.passwordInput = page.locator(loc.passwordInput);
    this.loginButton   = page.locator(loc.loginButton);
    this.errorAlert    = page.locator(loc.errorAlert);
  }

  /** Navigate to the login page. */
  async goto() {
    await this.page.goto('/web/index.php/auth/login');
    await this.page.waitForSelector(loc.usernameInput, { timeout: 15000 });
  }

  /**
   * Log in and wait for the dashboard.
   * @param {string} username
   * @param {string} password
   */
  async login(username, password) {
    await this.goto();
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.loginButton.click();
    await this.page.waitForURL('**/dashboard**', { timeout: 15000 });
  }

  /** Returns the visible error message text, or null. */
  async getErrorMessage() {
    const visible = await this.errorAlert.isVisible().catch(() => false);
    return visible ? this.errorAlert.textContent() : null;
  }
}

module.exports = { LoginPage };
