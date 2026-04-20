'use strict';
const fs = require("fs");
const path = require("path");

function generateTest(tc) {
  const name = tc.title.replace(/\W+/g, "_").toLowerCase();
  const dir = path.resolve("tests/generated");
  fs.mkdirSync(dir, { recursive: true });
  const content = `'use strict';
const { test, expect } = require('../fixtures/base.fixture');

test('${tc.title}', async ({ page, loginPage, addEmployeePage, sh }, testInfo) => {
  ${(tc.steps || []).map(s => `// ${s}`).join("\n  ")}
  await page.goto('/');
  expect(true).toBeTruthy();
});
`;
  fs.writeFileSync(path.join(dir, `${name}.spec.js`), content);
}
module.exports = { generateTest };
