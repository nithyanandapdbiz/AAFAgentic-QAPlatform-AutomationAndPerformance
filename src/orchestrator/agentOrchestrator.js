'use strict';
const { getStory } = require("../tools/jira.client");
const planner = require("../agents/planner.agent");
const qa = require("../agents/qa.agent");
const reviewer = require("../agents/reviewer.agent");
const riskPrioritizer = require("../agents/riskPrioritizer.agent");
const executor = require("../agents/executor.agent");
const logger = require("../utils/logger");

async function runAgentFlow(issueKey) {
  try {
    const story = await getStory(issueKey);
    const plan = await planner.plan(story);
    let testCases = await qa.generate(story, plan);
    testCases = await reviewer.review(testCases);
    testCases = await riskPrioritizer.prioritize(testCases, story);
    const { createdKeys } = await executor.execute(testCases);
    return { story, testCases, createdKeys };
  } catch (err) {
    logger.error(`Agent flow failed for ${issueKey}: ${err.message}`);
    throw err;
  }
}
module.exports = { runAgentFlow };
