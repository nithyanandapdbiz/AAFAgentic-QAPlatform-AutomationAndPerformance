'use strict';
const { createBug } = require("../tools/jiraBug.client");
const logger = require("../utils/logger");

async function createBugsForFailures(results, parentKey) {
  const failed = results.filter(r => !r.passed);
  const created = [];
  for (const t of failed) {
    try {
      const res = await createBug(t, parentKey);
      if (res?.data?.key) created.push(res.data.key);
    } catch (err) {
      logger.error(`Failed to create bug for "${t.title}": ${err.message}`);
    }
  }
  return created;
}
module.exports = { createBugsForFailures };
