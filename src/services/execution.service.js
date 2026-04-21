'use strict';
const { execFile, spawn } = require("child_process");
const fs   = require('fs');
const path = require('path');
const {
  TimeoutError,
  NonZeroExitError,
  SpawnError,
} = require("../core/errorHandler");

const PLAYWRIGHT_TIMEOUT_MS = parseInt(process.env.PLAYWRIGHT_EXEC_TIMEOUT_MS || '300000', 10);
const MAX_BUFFER_MB         = parseInt(process.env.PLAYWRIGHT_MAX_BUFFER_MB   || '50',     10);
const STREAM_OUTPUT         = process.env.PLAYWRIGHT_STREAM_OUTPUT === 'true';
const MAX_BUFFER_BYTES      = MAX_BUFFER_MB * 1024 * 1024;

function runPlaywright() {
  return STREAM_OUTPUT ? runPlaywrightStreamed() : runPlaywrightBuffered();
}

function runPlaywrightBuffered() {
  return new Promise((resolve, reject) => {
    const child = execFile("npx", ["playwright", "test"], {
      timeout:   PLAYWRIGHT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
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

      // Stdout/stderr buffer overflow — distinct, actionable error.
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
          /maxBuffer length exceeded/i.test(err.message || '')) {
        return reject(new NonZeroExitError(
          `Playwright output exceeded ${MAX_BUFFER_MB}MB buffer`,
          {
            details: { buffer: err.code || 'BUFFER_OVERFLOW', stdout: truncate(stdout), stderr: truncate(stderr) },
            recoveryHint: 'Increase PLAYWRIGHT_MAX_BUFFER_MB or set PLAYWRIGHT_STREAM_OUTPUT=true to stream output to disk.'
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

/**
 * Stream mode: output is piped to logs/playwright-<pid>.log so there is no
 * in-memory buffer. Used for large/soak-style suites where bounded RAM matters.
 */
function runPlaywrightStreamed() {
  return new Promise((resolve, reject) => {
    const logsDir = path.resolve(__dirname, '..', '..', 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const logFile   = path.join(logsDir, `playwright-${Date.now()}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    const child = spawn('npx', ['playwright', 'test'], {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_e) {}
    }, PLAYWRIGHT_TIMEOUT_MS);

    child.stdout.on('data', c => logStream.write(c));
    child.stderr.on('data', c => logStream.write(c));

    child.on('error', (err) => {
      clearTimeout(timer); logStream.end();
      reject(new SpawnError(`Failed to spawn Playwright: ${err.message}`, { details: { spawnCode: err.code, logFile } }));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer); logStream.end();
      if (signal === 'SIGTERM') {
        return reject(new TimeoutError(`Playwright execution exceeded ${PLAYWRIGHT_TIMEOUT_MS}ms`, { details: { logFile } }));
      }
      if (code === 0) return resolve(`Playwright completed — output streamed to ${logFile}`);
      reject(new NonZeroExitError(`Playwright exited with code ${code}`, {
        details: { exitCode: code, logFile },
        recoveryHint: `Review ${logFile}.`
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
