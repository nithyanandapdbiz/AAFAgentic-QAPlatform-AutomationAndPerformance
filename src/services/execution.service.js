'use strict';
const { execFile } = require("child_process");
const {
  TimeoutError,
  NonZeroExitError,
  SpawnError,
} = require("../core/errorHandler");

const PLAYWRIGHT_TIMEOUT_MS = parseInt(process.env.PLAYWRIGHT_EXEC_TIMEOUT_MS || '300000', 10);

function runPlaywright() {
  return new Promise((resolve, reject) => {
    const child = execFile("npx", ["playwright", "test"], {
      timeout:   PLAYWRIGHT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      shell:     true
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);

      // Timeout (SIGTERM killed due to timeout)
      if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
        return reject(new TimeoutError(
          `Playwright execution exceeded ${PLAYWRIGHT_TIMEOUT_MS}ms`,
          {
            details: { stdout: truncate(stdout), stderr: truncate(stderr) },
            recoveryHint: 'Raise PLAYWRIGHT_EXEC_TIMEOUT_MS or split the spec suite.'
          }
        ));
      }

      // Spawn failure (binary not found, EACCES etc.) — no exit code present
      if (err.code === 'ENOENT' || err.code === 'EACCES' || typeof err.code === 'string') {
        return reject(new SpawnError(
          `Failed to spawn Playwright: ${err.message}`,
          {
            details: { spawnCode: err.code },
            recoveryHint: 'Check that Node and `npx playwright` are installed (`npx playwright --version`).'
          }
        ));
      }

      // Non-zero exit: ran to completion but tests failed / internal error
      return reject(new NonZeroExitError(
        `Playwright exited with code ${err.code}`,
        {
          details: {
            exitCode: err.code,
            stdout:   truncate(stdout),
            stderr:   truncate(stderr)
          },
          recoveryHint: 'Review Playwright stdout/stderr and fix failing specs, or run reactive-heal.'
        }
      ));
    });

    child.on('error', (spawnErr) => {
      reject(new SpawnError(`Playwright process error: ${spawnErr.message}`, {
        details: { spawnCode: spawnErr.code }
      }));
    });
  });
}

function truncate(s, max = 4000) {
  if (!s) return '';
  const str = String(s);
  return str.length > max ? str.slice(0, max) + `…(+${str.length - max} chars)` : str;
}
module.exports = { runPlaywright };
