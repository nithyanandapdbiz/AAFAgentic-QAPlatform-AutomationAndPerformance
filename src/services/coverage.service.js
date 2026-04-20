'use strict';

function calculateCoverage(testCases, story) {
  if (!testCases || testCases.length === 0) {
    return { coverage: 0, covered: 0, total: 0 };
  }

  const fields = story?.fields || {};
  const storyText = [
    fields.summary || "",
    fields.description?.content?.map(c => c.content?.map(t => t.text || "").join(" ")).join(" ") || "",
    ...(fields.labels || []),
    ...(Object.values(fields.customfield_10020 || {}).map(v => String(v)))
  ].join(" ").toLowerCase();

  // Match test cases whose title keywords overlap with story content
  const covered = testCases.filter(tc => {
    const keywords = tc.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    return keywords.some(kw => storyText.includes(kw));
  }).length;

  return {
    coverage: testCases.length ? Math.round((covered / testCases.length) * 100) : 0,
    covered,
    total: testCases.length
  };
}
module.exports = { calculateCoverage };
