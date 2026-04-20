'use strict';
/**
 * Test data constants for OrangeHRM automation.
 * Application: https://opensource-demo.orangehrmlive.com
 * Module:      PIM → Add Employee
 */

module.exports = {

  BASE_URL: 'https://opensource-demo.orangehrmlive.com',

  /** Login credentials. */
  CREDENTIALS: {
    admin: {
      username: 'Admin',
      password: 'admin123'
    }
  },

  /** Default employee data used across happy-path and persistence tests. */
  TEST_EMPLOYEE: {
    firstName:  'AutoTest',
    middleName: '',
    lastName:   'Employee'
  },

  /** Application route paths (appended to BASE_URL). */
  ROUTES: {
    login:          '/web/index.php/auth/login',
    dashboard:      '/web/index.php/dashboard/index',
    addEmployee:    '/web/index.php/pim/addEmployee',
    employeeList:   '/web/index.php/pim/viewEmployeeList',
    personalDetails: '/web/index.php/pim/viewPersonalDetails/empNumber/'
  }
};
