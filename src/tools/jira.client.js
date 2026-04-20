'use strict';
const axios = require("axios");
const config = require("../core/config");

async function getStory(key) {
  if (!/^[A-Z]+-\d+$/i.test(key)) {
    throw new Error(`Invalid issue key format: ${key}`);
  }
  const res = await axios.get(`${config.jira.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}`, {
    auth: { username: config.jira.email, password: config.jira.token }
  });
  return res.data;
}
module.exports = { getStory };
