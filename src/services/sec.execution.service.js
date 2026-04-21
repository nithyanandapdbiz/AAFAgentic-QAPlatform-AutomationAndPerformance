'use strict';
/** @module sec.execution.service — Starts/stops OWASP ZAP, runs active and passive scans, executes custom security checks, parses findings, and syncs to Zephyr/Jira. */

const fs            = require('fs');
const path          = require('path');
const http          = require('http');
const https         = require('https');
const { spawnSync } = require('child_process');
const logger        = require('../utils/logger');
const AppError      = require('../core/errorHandler');
const { retry }     = require('../utils/retry');

const ROOT = path.resolve(__dirname, '..', '..');

// ─── ZAP config helpers ──────────────────────────────────────────────────────
function zapUrl(path_) {
  const base = (process.env.ZAP_API_URL || 'http://localhost:8080').replace(/\/$/, '');
  return `${base}${path_}`;
}

function zapApiKey() {
  return process.env.ZAP_API_KEY || 'changeme';
}

/** Simple promisified HTTP/HTTPS GET returning { statusCode, body } */
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

/** Simple promisified HTTP POST with a body string */
function httpPost(url, bodyStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers,
      },
    };
    const req = mod.request(opts, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Timeout POST: ${url}`)); });
    req.write(bodyStr);
    req.end();
  });
}

/** Poll a ZAP status URL until it returns "100" or timeout (ms) */
async function pollZapStatus(statusUrl, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await httpGet(statusUrl);
      const data = JSON.parse(res.body || '{}');
      const status = data.status || data.scanProgress || '0';
      if (String(status) === '100') return true;
      logger.info(`[ZAP] Scan progress: ${status}%`);
    } catch { /* ZAP not ready yet */ }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new AppError(`ZAP scan timed out after ${timeoutMs / 1000}s`);
}

// ─── startZap ────────────────────────────────────────────────────────────────

/**
 * Checks if ZAP is running; optionally starts it via Docker.
 * @param {object} zapConfig
 * @returns {{ started: boolean, version: string }}
 */
async function startZap(zapConfig) {
  try {
    // Try to reach ZAP
    try {
      const res = await httpGet(zapUrl(`/JSON/core/view/version/?apikey=${zapApiKey()}`));
      if (res.statusCode === 200) {
        const data = JSON.parse(res.body || '{}');
        const version = data.version || 'unknown';
        logger.info(`[ZAP] Already running, version: ${version}`);
        return { started: true, version };
      }
    } catch { /* not running yet */ }

    if (process.env.ZAP_DOCKER !== 'true') {
      logger.warn('[ZAP] ZAP not reachable and ZAP_DOCKER is not true — skipping ZAP start');
      return { started: false, version: 'unavailable' };
    }

    // Start ZAP via Docker
    logger.info('[ZAP] Starting ZAP Docker container...');
    const dockerArgs = [
      'run', '-d', '-p', '8080:8080', '--name', 'zap',
      'zaproxy/zap-stable',
      'zap.sh', '-daemon', '-host', '0.0.0.0', '-port', '8080',
      `-config`, `api.key=${zapApiKey()}`,
    ];
    const spawnResult = spawnSync('docker', dockerArgs, { encoding: 'utf8' });
    if (spawnResult.error) throw new AppError(`Docker error: ${spawnResult.error.message}`);

    // Poll until ZAP is ready (up to 60s)
    const start = Date.now();
    while (Date.now() - start < 60000) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const res = await httpGet(zapUrl(`/JSON/core/view/version/?apikey=${zapApiKey()}`));
        if (res.statusCode === 200) {
          const data = JSON.parse(res.body || '{}');
          logger.info(`[ZAP] Docker container ready, version: ${data.version}`);
          return { started: true, version: data.version || 'unknown' };
        }
      } catch { /* still starting */ }
    }
    throw new AppError('ZAP Docker container did not become ready within 60s');
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`startZap failed: ${err.message}`);
  }
}

// ─── runZapScan ──────────────────────────────────────────────────────────────

/**
 * Runs a ZAP scan (spider + active or passive) and writes the JSON report.
 * @param {object} zapConfig
 * @returns {string} Path to the written JSON report
 */
async function runZapScan(zapConfig) {
  try {
    const storyKey = zapConfig.contextName.replace('-context', '');
    const outDir   = path.join(ROOT, 'test-results', 'security');
    fs.mkdirSync(outDir, { recursive: true });
    const reportPath = path.join(outDir, `${storyKey}-zap-report.json`);

    const key = encodeURIComponent(zapApiKey());
    const url = encodeURIComponent(zapConfig.targetUrl);

    // Optional: set form-based authentication
    if (zapConfig.authScript) {
      const loginUrl = encodeURIComponent(`${zapConfig.targetUrl}/web/index.php/auth/validateCredentials`);
      const authBody = `apikey=${key}&contextId=1&authMethodName=formBasedAuthentication`
        + `&authMethodConfigParams=loginUrl%3D${loginUrl}%26loginRequestData%3DtxtUsername%3DAdmin%26txtPassword%3Dadmin123`;
      try {
        await httpPost(
          zapUrl('/JSON/authentication/action/setAuthenticationMethod/'),
          authBody
        );
        logger.info('[ZAP] Auth method configured');
      } catch (e) {
        logger.warn(`[ZAP] Auth config failed (non-fatal): ${e.message}`);
      }
    }

    // Spider
    logger.info(`[ZAP] Starting spider on: ${zapConfig.targetUrl}`);
    const spiderRes = await httpPost(
      zapUrl('/JSON/spider/action/scan/'),
      `apikey=${key}&url=${url}&recurse=true`
    );
    const spiderData = JSON.parse(spiderRes.body || '{}');
    const scanId = spiderData.scan || '0';

    await pollZapStatus(
      zapUrl(`/JSON/spider/view/status/?apikey=${key}&scanId=${scanId}`),
      180000
    );
    logger.info('[ZAP] Spider complete');

    // Active scan or passive scan
    if (zapConfig.scanType === 'full' || zapConfig.scanType === 'api') {
      logger.info('[ZAP] Starting active scan...');
      const ascanRes = await httpPost(
        zapUrl('/JSON/ascan/action/scan/'),
        `apikey=${key}&url=${url}&recurse=true`
      );
      const ascanData = JSON.parse(ascanRes.body || '{}');
      const ascanId   = ascanData.scan || '0';

      await pollZapStatus(
        zapUrl(`/JSON/ascan/view/status/?apikey=${key}&scanId=${ascanId}`),
        600000
      );
      logger.info('[ZAP] Active scan complete');
    } else {
      // Baseline — enable passive scanners and wait
      await httpPost(zapUrl('/JSON/pscan/action/enableAllScanners/'), `apikey=${key}`);
      logger.info('[ZAP] Passive scan — waiting 30s...');
      await new Promise(r => setTimeout(r, 30000));
    }

    // Fetch JSON report
    const reportRes = await httpGet(zapUrl(`/JSON/core/other/jsonreport/?apikey=${key}`));
    fs.writeFileSync(reportPath, reportRes.body, 'utf8');
    logger.info(`[ZAP] Report written: ${reportPath}`);
    return reportPath;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`runZapScan failed: ${err.message}`);
  }
}

// ─── stopZap ─────────────────────────────────────────────────────────────────

/**
 * Gracefully shuts down ZAP and optionally stops the Docker container.
 */
async function stopZap() {
  try {
    const key = encodeURIComponent(zapApiKey());
    try {
      await httpPost(zapUrl('/JSON/core/action/shutdown/'), `apikey=${key}`);
      logger.info('[ZAP] Shutdown signal sent');
    } catch { /* ZAP may already be stopped */ }

    if (process.env.ZAP_DOCKER === 'true') {
      spawnSync('docker', ['stop', 'zap'], { encoding: 'utf8' });
      logger.info('[ZAP] Docker container stopped');
    }
  } catch (err) {
    logger.warn(`[ZAP] stopZap error (non-fatal): ${err.message}`);
  }
}

// ─── Custom checks ────────────────────────────────────────────────────────────

/**
 * Builds a cookie string from an array of Set-Cookie headers.
 */
function buildCookieString(setCookieHeaders) {
  if (!setCookieHeaders) return '';
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  return arr
    .map(h => h.split(';')[0].trim())
    .join('; ');
}

/**
 * Perform a GET and return the full response (following one redirect if needed).
 */
async function safeGet(url, headers = {}) {
  try {
    return await httpGet(url, headers);
  } catch { return { statusCode: 0, headers: {}, body: '' }; }
}

/**
 * Perform a POST and return the full response.
 */
async function safePost(url, body, headers = {}) {
  try {
    return await httpPost(url, body, headers);
  } catch { return { statusCode: 0, headers: {}, body: '' }; }
}

// ─── Individual custom check implementations ─────────────────────────────────

async function checkMissingSecurityHeaders(targetUrl) {
  const REQUIRED_HEADERS = [
    { name: 'strict-transport-security', display: 'Strict-Transport-Security' },
    { name: 'x-content-type-options',    display: 'X-Content-Type-Options' },
    { name: 'x-frame-options',           display: 'X-Frame-Options' },
    { name: 'content-security-policy',   display: 'Content-Security-Policy' },
    { name: 'referrer-policy',           display: 'Referrer-Policy' },
    { name: 'permissions-policy',        display: 'Permissions-Policy' },
  ];
  const res = await safeGet(targetUrl);
  const missing = REQUIRED_HEADERS.filter(h => !res.headers[h.name]);
  const passed  = missing.length === 0;
  return {
    name:        'missing-security-headers',
    passed,
    severity:    passed ? 'informational' : 'medium',
    cvss:        passed ? 0 : 5.3,
    owaspId:     'A05:2021',
    description: passed
      ? 'All required security headers are present'
      : `Missing headers: ${missing.map(h => h.display).join(', ')}`,
    evidence:    missing.map(h => h.display).join(', '),
  };
}

async function checkInsecureCookieFlags(targetUrl) {
  const res = await safeGet(`${targetUrl}/web/index.php/auth/login`);
  const setCookies = res.headers['set-cookie'] || [];
  const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
  const insecure = arr.filter(c => {
    const cl = c.toLowerCase();
    return !cl.includes('secure') || !cl.includes('httponly');
  });
  const passed = insecure.length === 0;
  return {
    name:        'insecure-cookie-flags',
    passed,
    severity:    passed ? 'informational' : 'medium',
    cvss:        passed ? 0 : 4.3,
    owaspId:     'A05:2021',
    description: passed
      ? 'All cookies have Secure and HttpOnly flags'
      : `Cookies missing Secure/HttpOnly: ${insecure.length} cookie(s)`,
    evidence:    insecure.map(c => c.split(';')[0]).join(' | ').slice(0, 300),
  };
}

async function checkSessionFixation(targetUrl) {
  // Step 1: get pre-auth session cookie
  const loginPage = await safeGet(`${targetUrl}/web/index.php/auth/login`);
  const preAuthCookie = buildCookieString(loginPage.headers['set-cookie']);

  // Step 2: authenticate
  const loginRes = await safePost(
    `${targetUrl}/web/index.php/auth/validateCredentials`,
    'txtUsername=Admin&txtPassword=admin123',
    { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': preAuthCookie }
  );
  const postAuthCookie = buildCookieString(loginRes.headers['set-cookie']);

  // If cookies are empty or same → session fixation
  const unchanged = preAuthCookie && postAuthCookie &&
    preAuthCookie.split(';')[0] === postAuthCookie.split(';')[0];
  const passed = !unchanged;
  return {
    name:        'session-fixation',
    passed,
    severity:    passed ? 'informational' : 'high',
    cvss:        passed ? 0 : 7.5,
    owaspId:     'A07:2021',
    description: passed
      ? 'Session token changes after authentication'
      : 'Session token did not change after login — possible session fixation vulnerability',
    evidence:    `Pre-auth token: ${preAuthCookie.slice(0, 30) || 'none'} | Post-auth: ${postAuthCookie.slice(0, 30) || 'none'}`,
  };
}

async function checkOpenRedirect(targetUrl) {
  const probeUrl = `${targetUrl}/web/index.php/auth/login?redirect=https://evil.com`;
  const res = await safeGet(probeUrl);
  const location  = res.headers['location'] || '';
  const passed    = !location.includes('evil.com');
  return {
    name:        'open-redirect',
    passed,
    severity:    passed ? 'informational' : 'medium',
    cvss:        passed ? 0 : 6.1,
    owaspId:     'A10:2021',
    description: passed
      ? 'No open redirect detected'
      : `Open redirect: Location header contains attacker-controlled domain`,
    evidence:    location ? `Location: ${location.slice(0, 200)}` : 'No redirect',
  };
}

async function checkSensitiveDataInResponse(targetUrl, sessionCookies) {
  const PATTERNS = [/password/i, /secret/i, /token/i, /apikey/i, /api_key/i, /ssn/i, /credit_card/i];
  const res = await safeGet(
    `${targetUrl}/web/index.php/api/v2/employee/search?name=Admin`,
    sessionCookies ? { Cookie: sessionCookies } : {}
  );
  const found = PATTERNS.filter(p => p.test(res.body));
  const passed = found.length === 0;
  return {
    name:        'sensitive-data-in-response',
    passed,
    severity:    passed ? 'informational' : 'high',
    cvss:        passed ? 0 : 7.5,
    owaspId:     'A02:2021',
    description: passed
      ? 'No sensitive data patterns detected in API response'
      : `Sensitive patterns found in response: ${found.map(p => p.source).join(', ')}`,
    evidence:    res.body.slice(0, 300),
  };
}

async function checkCsrfTokenAbsence(targetUrl, sessionCookies) {
  const res = await safeGet(
    `${targetUrl}/web/index.php/pim/addEmployee`,
    sessionCookies ? { Cookie: sessionCookies } : {}
  );
  const hasCsrf = /_token|csrf-token|csrf_token/i.test(res.body);
  const passed  = hasCsrf;
  return {
    name:        'csrf-token-absence',
    passed,
    severity:    passed ? 'informational' : 'high',
    cvss:        passed ? 0 : 8.1,
    owaspId:     'A01:2021',
    description: passed
      ? 'CSRF token found in form'
      : 'No CSRF token detected in add employee page form',
    evidence:    'Searched for: _token, csrf-token, csrf_token in HTML',
  };
}

async function checkIdorEmployeeId(targetUrl, sessionCookies) {
  const headers = sessionCookies ? { Cookie: sessionCookies } : {};
  const r1 = await safeGet(`${targetUrl}/web/index.php/api/v2/employee/1`, headers);
  const r2 = await safeGet(`${targetUrl}/web/index.php/api/v2/employee/2`, headers);
  const idor = r1.statusCode === 200 && r2.statusCode === 200 && r1.body !== r2.body;
  return {
    name:        'idor-employee-id',
    passed:      !idor,
    severity:    idor ? 'high' : 'informational',
    cvss:        idor ? 8.1 : 0,
    owaspId:     'A01:2021',
    description: idor
      ? 'IDOR confirmed: employee records accessible by sequential ID enumeration'
      : 'No IDOR detected for employee endpoints',
    evidence:    idor ? `Employee/1 status=${r1.statusCode}, Employee/2 status=${r2.statusCode}` : '',
  };
}

async function checkSqlInjectionSignal(targetUrl) {
  const url = `${targetUrl}/web/index.php/pim/viewEmployeeList?searchParam=Admin'--`;
  const res = await safeGet(url);
  const isSqli = res.statusCode === 500
    || /SQL|syntax error|mysql_fetch|ORA-/i.test(res.body);
  return {
    name:        'sql-injection-signal',
    passed:      !isSqli,
    severity:    isSqli ? 'critical' : 'informational',
    cvss:        isSqli ? 9.8 : 0,
    owaspId:     'A03:2021',
    description: isSqli
      ? 'SQL injection signal detected: server returned error on SQL payload'
      : 'No SQL injection signal detected',
    evidence:    isSqli ? res.body.slice(0, 300) : '',
  };
}

async function checkXssReflectionSignal(targetUrl) {
  const payload   = '<script>alert(1)</script>';
  const url       = `${targetUrl}/web/index.php/pim/viewEmployeeList?searchParam=${encodeURIComponent(payload)}`;
  const res       = await safeGet(url);
  const reflected = res.body.includes(payload);
  return {
    name:        'xss-reflection-signal',
    passed:      !reflected,
    severity:    reflected ? 'high' : 'informational',
    cvss:        reflected ? 7.2 : 0,
    owaspId:     'A03:2021',
    description: reflected
      ? 'XSS reflection: script payload returned verbatim in response body'
      : 'No XSS reflection detected',
    evidence:    reflected ? payload : '',
  };
}

async function checkBrokenAuthBruteForce(targetUrl) {
  const loginUrl = `${targetUrl}/web/index.php/auth/validateCredentials`;
  const body     = 'txtUsername=Admin&txtPassword=wrongpassword';
  let lockoutDetected = false;
  let failedAllowed   = 0;
  for (let i = 0; i < 5; i++) {
    const res = await safePost(loginUrl, body, { 'Content-Type': 'application/x-www-form-urlencoded' });
    if (res.statusCode === 200) failedAllowed++;
    if (res.statusCode === 429 || /locked|captcha/i.test(res.body)) {
      lockoutDetected = true;
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  const passed = lockoutDetected || failedAllowed < 5;
  return {
    name:        'broken-auth-brute-force',
    passed,
    severity:    passed ? 'informational' : 'high',
    cvss:        passed ? 0 : 7.5,
    owaspId:     'A07:2021',
    description: passed
      ? 'Account lockout or rate limiting detected after failed login attempts'
      : 'No lockout after 5 failed login attempts — brute force protection absent',
    evidence:    `${failedAllowed}/5 failed attempts returned HTTP 200`,
  };
}

// Registry of all custom checks
const CUSTOM_CHECK_REGISTRY = {
  'missing-security-headers':    (url, cookies) => checkMissingSecurityHeaders(url),
  'insecure-cookie-flags':       (url, cookies) => checkInsecureCookieFlags(url),
  'session-fixation':            (url, cookies) => checkSessionFixation(url),
  'open-redirect':               (url, cookies) => checkOpenRedirect(url),
  'sensitive-data-in-response':  checkSensitiveDataInResponse,
  'csrf-token-absence':          checkCsrfTokenAbsence,
  'idor-employee-id':            checkIdorEmployeeId,
  'sql-injection-signal':        (url, cookies) => checkSqlInjectionSignal(url),
  'xss-reflection-signal':       (url, cookies) => checkXssReflectionSignal(url),
  'broken-auth-brute-force':     (url, cookies) => checkBrokenAuthBruteForce(url),
};

// ─── runCustomChecks ─────────────────────────────────────────────────────────

/**
 * Runs a list of named custom security checks sequentially.
 *
 * @param {string[]} checkNames    - Check names to run
 * @param {string}   targetUrl     - Base URL of the application
 * @param {string}   [sessionCookies] - Session cookie string for authenticated checks
 * @returns {Array} Array of check result objects
 */
async function runCustomChecks(checkNames, targetUrl, sessionCookies) {
  const results = [];
  for (const name of checkNames) {
    const fn = CUSTOM_CHECK_REGISTRY[name];
    if (!fn) {
      logger.warn(`[SecExecution] Unknown custom check: ${name}`);
      continue;
    }
    logger.info(`[SecExecution] Running check: ${name}`);
    try {
      const result = await fn(targetUrl, sessionCookies);
      results.push({ ...result, source: 'custom', url: targetUrl });
    } catch (err) {
      logger.warn(`[SecExecution] Check ${name} error: ${err.message}`);
      results.push({
        name, source: 'custom', passed: false, severity: 'informational',
        cvss: 0, owaspId: 'unknown', description: `Check error: ${err.message}`, evidence: '',
        url: targetUrl,
      });
    }
  }
  return results;
}

// ─── parseFindings ────────────────────────────────────────────────────────────

const SEVERITY_ORDER = ['informational', 'low', 'medium', 'high', 'critical'];

function zapRiskToSeverity(riskCode) {
  // ZAP risk codes: 0=informational, 1=low, 2=medium, 3=high
  const map = { '0': 'informational', '1': 'low', '2': 'medium', '3': 'high' };
  return map[String(riskCode)] || 'informational';
}

/**
 * Reads a ZAP JSON report and merges with custom check results.
 * @param {string} zapJsonPath  - Path to ZAP JSON report (may not exist)
 * @param {Array}  customResults - Results from runCustomChecks()
 * @returns {{ findings: Array, summary: object }}
 */
function parseFindings(zapJsonPath, customResults = []) {
  try {
    const findings = [];
    let idCounter = 1;

    // Parse ZAP report
    if (zapJsonPath && fs.existsSync(zapJsonPath)) {
      try {
        const raw  = fs.readFileSync(zapJsonPath, 'utf8');
        const data = JSON.parse(raw);
        const alerts = data.alerts || data.site?.[0]?.alerts || [];
        for (const alert of alerts) {
          findings.push({
            id:          `ZAP-${idCounter++}`,
            source:      'zap',
            name:        alert.name || alert.alert || 'Unknown',
            severity:    zapRiskToSeverity(alert.riskcode),
            cvss:        parseFloat(alert.riskdesc?.split(' ')[0] || '0') || 0,
            owaspId:     alert.owaspid || 'A05:2021',
            description: alert.description || '',
            evidence:    (alert.instances?.[0]?.evidence || alert.evidence || '').slice(0, 300),
            url:         alert.instances?.[0]?.uri || alert.url || '',
            solution:    alert.solution || '',
          });
        }
      } catch (e) {
        logger.warn(`[SecExecution] Could not parse ZAP report: ${e.message}`);
      }
    }

    // Add custom check findings (only failures)
    for (const r of customResults) {
      if (!r.passed) {
        findings.push({
          id:          `CUSTOM-${idCounter++}`,
          source:      'custom',
          name:        r.name,
          severity:    r.severity,
          cvss:        r.cvss || 0,
          owaspId:     r.owaspId || 'unknown',
          description: r.description || '',
          evidence:    (r.evidence || '').slice(0, 300),
          url:         r.url || '',
          solution:    `Review and remediate: ${r.name}`,
        });
      }
    }

    // Sort by cvss descending
    findings.sort((a, b) => b.cvss - a.cvss);

    const summary = {
      critical:      findings.filter(f => f.severity === 'critical').length,
      high:          findings.filter(f => f.severity === 'high').length,
      medium:        findings.filter(f => f.severity === 'medium').length,
      low:           findings.filter(f => f.severity === 'low').length,
      informational: findings.filter(f => f.severity === 'informational').length,
    };

    return { findings, summary };
  } catch (err) {
    throw new AppError(`parseFindings failed: ${err.message}`);
  }
}

// ─── evaluateSeverity ─────────────────────────────────────────────────────────

/**
 * Evaluates findings against the severity policy.
 * @param {Array}  findings
 * @param {object} severityPolicy - { failOn, warnOn, maxIssues }
 * @returns {{ verdict: string, highestSeverity: string, breachingFindings: Array }}
 */
function evaluateSeverity(findings, severityPolicy) {
  const failIdx = SEVERITY_ORDER.indexOf(severityPolicy.failOn || 'high');
  const warnIdx = SEVERITY_ORDER.indexOf(severityPolicy.warnOn || 'medium');

  const breachingFindings = findings.filter(f => {
    const fIdx = SEVERITY_ORDER.indexOf(f.severity);
    return fIdx >= failIdx;
  });

  const warnFindings = findings.filter(f => {
    const fIdx = SEVERITY_ORDER.indexOf(f.severity);
    return fIdx >= warnIdx && fIdx < failIdx;
  });

  const highestSeverity = findings.reduce((acc, f) => {
    return SEVERITY_ORDER.indexOf(f.severity) > SEVERITY_ORDER.indexOf(acc) ? f.severity : acc;
  }, 'informational');

  let verdict;
  if (breachingFindings.length > 0) verdict = 'fail';
  else if (warnFindings.length > 0)  verdict = 'warn';
  else                                verdict = 'pass';

  return { verdict, highestSeverity, breachingFindings };
}

// ─── syncToZephyrAndJira ──────────────────────────────────────────────────────

/**
 * Updates Zephyr test executions and creates Jira bugs for security findings.
 * @param {Array}  findings
 * @param {string} verdict
 * @param {string} storyKey
 * @param {object} options - { skipBugs }
 */
async function syncToZephyrAndJira(findings, verdict, storyKey, options = {}) {
  try {
    const zephyrExec = require('../tools/zephyrExecution.client');
    const jiraBug    = require('../tools/jiraBug.client');

    const verdictToZephyr = { pass: 'Pass', warn: 'Blocked', fail: 'Fail' };
    const zephyrStatus    = verdictToZephyr[verdict] || 'Blocked';

    // Load test case map
    const tcMapPath = path.join(ROOT, 'tests', 'security', 'sec-testcase-map.json');
    let tcMap = {};
    if (fs.existsSync(tcMapPath)) {
      try { tcMap = JSON.parse(fs.readFileSync(tcMapPath, 'utf8')); } catch { /* ignore */ }
    }

    const tcKey = tcMap[storyKey];
    if (tcKey) {
      try {
        await retry(() => zephyrExec.createExecution(
          process.env.ZEPHYR_CYCLE_KEY || '',
          tcKey,
          zephyrStatus,
          { comment: `Security scan verdict: ${verdict}` }
        ), 3, 1500);
        logger.info(`[SecExecution] Zephyr synced: ${storyKey} → ${zephyrStatus}`);
      } catch (e) {
        logger.warn(`[SecExecution] Zephyr sync failed for ${storyKey}: ${e.message}`);
      }
    }

    if (!options.skipBugs) {
      const critical = findings.filter(f => f.severity === 'critical' || f.severity === 'high');
      for (const finding of critical) {
        const bugSummary = `SEC: ${finding.name} — ${finding.severity} — ${storyKey}`;
        const bugDesc = [
          `OWASP ID: ${finding.owaspId}`,
          `CVSS Score: ${finding.cvss}`,
          `Evidence: ${(finding.evidence || 'N/A').slice(0, 200)}`,
          `Affected URL: ${finding.url || 'N/A'}`,
          `Solution: ${finding.solution || 'N/A'}`,
        ].join('\n');

        try {
          await retry(() => jiraBug.createBug(
            { title: bugSummary, error: bugDesc, file: `tests/security/${storyKey}-scan-config.json` },
            storyKey
          ), 3, 1500);
          logger.info(`[SecExecution] Jira bug created: ${bugSummary}`);
        } catch (e) {
          logger.warn(`[SecExecution] Jira bug creation failed for ${finding.name}: ${e.message}`);
        }
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`syncToZephyrAndJira failed: ${err.message}`);
  }
}

// ─── runFullScan (convenience for qa-run.js) ─────────────────────────────────

/**
 * Runs the full security scan for a story: generate config, custom checks, parse findings.
 * @param {object} opts - { storyKey }
 * @returns {{ findings: Array, verdict: string, summary: object }}
 */
async function runFullScan(opts = {}) {
  const { storyKey = process.env.ISSUE_KEY || 'UNKNOWN' } = opts;
  const targetUrl = process.env.BASE_URL || 'https://opensource-demo.orangehrmlive.com';

  // Load config
  const configPath = path.join(ROOT, 'tests', 'security', `${storyKey}-scan-config.json`);
  let checkNames   = Object.keys(CUSTOM_CHECK_REGISTRY);
  if (fs.existsSync(configPath)) {
    try {
      const cfg  = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      checkNames = cfg.customChecks || checkNames;
    } catch { /* use defaults */ }
  }

  const customResults = await runCustomChecks(checkNames, targetUrl, '');

  const zapReportPath = path.join(ROOT, 'test-results', 'security', `${storyKey}-zap-report.json`);
  const { findings, summary } = parseFindings(zapReportPath, customResults);

  const severityPolicy = {
    failOn:    process.env.ZAP_FAIL_ON   || 'high',
    warnOn:    process.env.ZAP_WARN_ON   || 'medium',
    maxIssues: parseInt(process.env.ZAP_MAX_ISSUES || '0', 10),
  };
  const { verdict } = evaluateSeverity(findings, severityPolicy);

  return { findings, verdict, summary };
}

module.exports = {
  startZap,
  runZapScan,
  stopZap,
  runCustomChecks,
  parseFindings,
  evaluateSeverity,
  syncToZephyrAndJira,
  runFullScan,
};
