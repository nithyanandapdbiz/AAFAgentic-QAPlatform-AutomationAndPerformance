'use strict';
/**
 * pom.fixture.js
 *
 * Extends @playwright/test with Page Object Model fixtures.
 *
 * Fixtures:
 *   loginPage        — LoginPage instance
 *   addEmployeePage  — AddEmployeePage instance
 *   employeeListPage — EmployeeListPage instance
 *   uniqueSuffix     — 5-digit timestamp suffix for unique test data
 */

const { test: base, expect } = require('@playwright/test');
const { LoginPage }        = require('../pages/LoginPage');
const { AddEmployeePage }  = require('../pages/AddEmployeePage');
const { EmployeeListPage } = require('../pages/EmployeeListPage');

const test = base.extend({
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  addEmployeePage: async ({ page }, use) => {
    await use(new AddEmployeePage(page));
  },

  employeeListPage: async ({ page }, use) => {
    await use(new EmployeeListPage(page));
  },

  uniqueSuffix: async ({}, use) => {
    await use(String(Date.now()).slice(-5));
  },
});

module.exports = { test, expect };
