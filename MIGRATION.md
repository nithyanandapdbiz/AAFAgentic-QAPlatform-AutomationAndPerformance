# Migration Guide — Legacy Pipeline Scripts

> Status: **active** · Last updated: April 2026

The Agentic QA Platform ships four pipeline entry points. Only one of them is
the long-term supported path; the other three are retained for backward
compatibility and will be removed in a future major release.

## Supported (long-term)

| Entry point | Command | Preset |
|---|---|---|
| **Consolidated runner** | `node scripts/run-full-pipeline.js --use-runner --include-perf --include-security` | `full` |
| | `npm run pipeline:full` | `full` |
| | `npm run pipeline:functional` | `functional` |

The consolidated runner is implemented in [`src/pipeline/runner.js`](src/pipeline/runner.js) and composed from the named steps in [`src/pipeline/steps.js`](src/pipeline/steps.js) according to the presets in [`src/pipeline/presets.js`](src/pipeline/presets.js). It provides:

- Pre-flight health checks that fail fast on missing credentials/binaries
- Per-step classified errors (`TimeoutError`, `NonZeroExitError`, `SpawnError`, `UpstreamError`, `PreconditionError`) with machine-readable `recoveryHint`
- Critical-step halt with `logs/pipeline-failure-report.{json,md}`
- Proper non-zero exit codes for CI

## Deprecated (kept for back-compat)

| Legacy script | Replacement command |
|---|---|
| `scripts/qa-run.js` | `node scripts/run-full-pipeline.js --use-runner`  (preset: `functional`) |
| `scripts/run-qa-complete.js` | `node scripts/run-full-pipeline.js --use-runner --include-perf --include-security` |
| `scripts/run-e2e.js` | `node scripts/run-full-pipeline.js --use-runner --include-perf --include-security` |

Each legacy script now carries an `@deprecated` JSDoc banner and logs a one-line warning to `logs/deprecation-warnings.log` when invoked. Their functional behaviour is unchanged.

## Removal schedule

| Version | Change |
|---|---|
| **v1.x** (current) | All four entry points functional. Legacy scripts log deprecation warnings. |
| **v2.0.0** (planned) | Legacy scripts (`qa-run.js`, `run-qa-complete.js`, `run-e2e.js`) removed. `--use-runner` becomes the default in `run-full-pipeline.js`; `PIPELINE_USE_RUNNER=false` available for one minor version as an emergency rollback, then removed. |

## Migration steps

1. **Identify callers.** Grep your CI workflows, shell wrappers, and docs for `qa-run.js`, `run-qa-complete.js`, `run-e2e.js`.
2. **Swap commands.** Use the replacement table above. Flags map 1:1 except where noted:
   - `--skip-*` flags continue to work via `ctx.flags` on the consolidated runner.
   - `--headless` maps to `PW_HEADLESS=true` or the preset's default.
3. **Update `.env`.** Set `PIPELINE_PRESET` to `functional` / `full` / `scoped` / `perfOnly` / `secOnly` as appropriate (default `full`).
4. **Watch the failure report.** On critical halt, CI uploads `logs/pipeline-failure-report.{json,md}` — review the `recoveryHint` field.
5. **Remove the deprecation warning.** Delete any caller of the legacy scripts once migration is complete.

## Audit trail

Invocations of deprecated scripts append one line per run to `logs/deprecation-warnings.log`, including timestamp, script name, and caller-supplied args. Review this file periodically during the deprecation window.

---

_© Agentic QA Platform._
