'use strict';
const { execFile } = require("child_process");

function runPlaywright() {
  return new Promise((resolve, reject) => {
    execFile("npx", ["playwright", "test"], {
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
      shell: true
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Playwright failed: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
}
module.exports = { runPlaywright };
