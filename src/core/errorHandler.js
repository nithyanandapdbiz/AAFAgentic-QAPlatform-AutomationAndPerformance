'use strict';

/**
 * AppError — base error with HTTP-status + actionable recovery hint.
 *
 * Subclasses carry distinct `code` values so callers (CI, API middleware,
 * dashboards) can branch on failure class without regex-matching messages.
 */
class AppError extends Error {
  /**
   * @param {string} message
   * @param {number} [status=500]
   * @param {object} [opts]
   * @param {string} [opts.code]         - stable error code e.g. "TIMEOUT"
   * @param {string} [opts.recoveryHint] - one-line actionable remediation
   * @param {object} [opts.details]      - freeform structured details
   */
  constructor(message, status = 500, opts = {}) {
    super(message);
    this.name         = this.constructor.name;
    this.status       = status;
    this.code         = opts.code || 'APP_ERROR';
    this.recoveryHint = opts.recoveryHint || null;
    this.details      = opts.details || null;
  }

  toJSON() {
    return {
      name:         this.name,
      message:      this.message,
      status:       this.status,
      code:         this.code,
      recoveryHint: this.recoveryHint,
      details:      this.details
    };
  }
}

/** Process exceeded wall-clock limit. Often recoverable by retrying with more time. */
class TimeoutError extends AppError {
  constructor(message, opts = {}) {
    super(message, 504, {
      code: 'TIMEOUT',
      recoveryHint: opts.recoveryHint ||
        'Increase the timeout via environment variable or reduce workload scope.',
      ...opts
    });
  }
}

/** Child process exited with a non-zero exit code (ran to completion but failed). */
class NonZeroExitError extends AppError {
  constructor(message, opts = {}) {
    super(message, 500, {
      code: 'NON_ZERO_EXIT',
      recoveryHint: opts.recoveryHint ||
        'Inspect the tool stdout/stderr for the actual failure and re-run.',
      ...opts
    });
  }
}

/** Failed to spawn the child process at all (binary missing, permission denied). */
class SpawnError extends AppError {
  constructor(message, opts = {}) {
    super(message, 500, {
      code: 'SPAWN_FAILED',
      recoveryHint: opts.recoveryHint ||
        'Verify the binary is installed and on PATH (e.g. run `where k6` / `where npx`).',
      ...opts
    });
  }
}

/** External dependency (Jira, Zephyr, ZAP) not reachable. */
class UpstreamError extends AppError {
  constructor(message, opts = {}) {
    super(message, 502, {
      code: 'UPSTREAM_UNAVAILABLE',
      recoveryHint: opts.recoveryHint ||
        'Verify credentials and connectivity to the upstream service.',
      ...opts
    });
  }
}

/** Precondition for a pipeline stage was not met. */
class PreconditionError extends AppError {
  constructor(message, opts = {}) {
    super(message, 412, {
      code: 'PRECONDITION_FAILED',
      recoveryHint: opts.recoveryHint ||
        'Run the prior stage or ensure required inputs exist.',
      ...opts
    });
  }
}

module.exports = AppError;
module.exports.AppError          = AppError;
module.exports.TimeoutError      = TimeoutError;
module.exports.NonZeroExitError  = NonZeroExitError;
module.exports.SpawnError        = SpawnError;
module.exports.UpstreamError     = UpstreamError;
module.exports.PreconditionError = PreconditionError;
