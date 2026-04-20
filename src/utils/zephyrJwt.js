'use strict';
/**
 * Zephyr Essential Cloud API v2.8 authentication helper.
 * Auth is a plain API token passed as: Authorization: <token>
 * No JWT signing is required for this API version.
 */
function zephyrHeaders() {
  const config = require("../core/config");
  return {
    Authorization: config.zephyr.token,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };
}

module.exports = { zephyrHeaders };

