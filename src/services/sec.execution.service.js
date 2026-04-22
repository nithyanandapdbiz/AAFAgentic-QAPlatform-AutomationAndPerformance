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
  const pollMs = parseInt(process.env.ZAP_POLL_INTERVAL_MS || '2000', 10);
  const start  = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await httpGet(statusUrl);
      const data = JSON.parse(res.body || '{}');
      const status = data.status || data.scanProgress || '0';
      if (String(status) === '100') return true;
      logger.info(`[ZAP] Scan progress: ${status}%`);
    } catch { /* ZAP not ready yet */ }
    await new Promise(r => setTimeout(r, pollMs));
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
      logger.info('[ZAP] ZAP not reachable and ZAP_DOCKER is not true — ZAP scan will be skipped');
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

    // Configure spider speed limits before crawl
    const spiderMaxDepth    = parseInt(process.env.ZAP_SPIDER_MAX_DEPTH         || '5',  10);
    const spiderMaxDurMins  = parseInt(process.env.ZAP_SPIDER_MAX_DURATION_MINS || '3',  10);
    const spiderMaxChildren = parseInt(process.env.ZAP_SPIDER_MAX_CHILDREN      || '10', 10);
    try {
      await httpPost(zapUrl('/JSON/spider/action/setOptionMaxDepth/'),    `apikey=${key}&Integer=${spiderMaxDepth}`);
      await httpPost(zapUrl('/JSON/spider/action/setOptionMaxDuration/'), `apikey=${key}&Integer=${spiderMaxDurMins}`);
      await httpPost(zapUrl('/JSON/spider/action/setOptionMaxChildren/'), `apikey=${key}&Integer=${spiderMaxChildren}`);
      logger.info(`[ZAP] Spider limits — depth:${spiderMaxDepth} duration:${spiderMaxDurMins}min children:${spiderMaxChildren}`);
    } catch (e) { logger.warn(`[ZAP] Spider config (non-fatal): ${e.message}`); }

    // Spider
    logger.info(`[ZAP] Starting spider on: ${zapConfig.targetUrl}`);
    const spiderRes = await httpPost(
      zapUrl('/JSON/spider/action/scan/'),
      `apikey=${key}&url=${url}&recurse=true`
    );
    const spiderData = JSON.parse(spiderRes.body || '{}');
    const scanId = spiderData.scan || '0';

    const spiderTimeoutMs = parseInt(process.env.ZAP_SPIDER_TIMEOUT_MS || '180000', 10);
    await pollZapStatus(
      zapUrl(`/JSON/spider/view/status/?apikey=${key}&scanId=${scanId}`),
      spiderTimeoutMs
    );
    logger.info('[ZAP] Spider complete');

    // Optional AJAX spider for JavaScript-rendered content
    if (zapConfig.ajaxSpider) {
      logger.info('[ZAP] Starting AJAX spider (max 2 min)...');
      try {
        await httpPost(zapUrl('/JSON/ajaxSpider/action/scan/'), `apikey=${key}&url=${url}&inScope=false`);
        const ajaxStart = Date.now();
        const ajaxPollMs = parseInt(process.env.ZAP_POLL_INTERVAL_MS || '2000', 10);
        while (Date.now() - ajaxStart < 120000) {
          await new Promise(r => setTimeout(r, ajaxPollMs));
          try {
            const st = await httpGet(zapUrl(`/JSON/ajaxSpider/view/status/?apikey=${key}`));
            if (JSON.parse(st.body || '{}').status === 'stopped') break;
          } catch { /* not ready */ }
        }
        logger.info('[ZAP] AJAX spider complete');
      } catch (e) {
        logger.info(`[ZAP] AJAX spider skipped: ${e.message}`);
      }
    }

    // Active scan or passive scan
    if (zapConfig.scanType === 'full' || zapConfig.scanType === 'api') {
      // Increase active scan thread count for faster scanning
      const ascanThreads = parseInt(process.env.ZAP_ASCAN_THREADS || '5', 10);
      try {
        await httpPost(zapUrl('/JSON/ascan/action/setOptionThreadPerHost/'), `apikey=${key}&Integer=${ascanThreads}`);
        logger.info(`[ZAP] Active scan threads per host: ${ascanThreads}`);
      } catch (e) { logger.warn(`[ZAP] Ascan thread config (non-fatal): ${e.message}`); }

      logger.info('[ZAP] Starting active scan...');
      const ascanRes = await httpPost(
        zapUrl('/JSON/ascan/action/scan/'),
        `apikey=${key}&url=${url}&recurse=true`
      );
      const ascanData = JSON.parse(ascanRes.body || '{}');
      const ascanId   = ascanData.scan || '0';

      const activeScanTimeout = parseInt(process.env.ZAP_SCAN_TIMEOUT_MS || '1200000', 10);
      await pollZapStatus(
        zapUrl(`/JSON/ascan/view/status/?apikey=${key}&scanId=${ascanId}`),
        activeScanTimeout
      );
      logger.info('[ZAP] Active scan complete');
    } else {
      // Baseline — enable passive scanners and wait
      await httpPost(zapUrl('/JSON/pscan/action/enableAllScanners/'), `apikey=${key}`);
      const passiveWaitMs = parseInt(process.env.ZAP_PASSIVE_WAIT_MS || '15000', 10);
      logger.info(`[ZAP] Passive scan — waiting ${passiveWaitMs / 1000}s...`);
      await new Promise(r => setTimeout(r, passiveWaitMs));
    }

    // Fetch JSON report — validate before writing
    const reportRes = await httpGet(zapUrl(`/JSON/core/other/jsonreport/?apikey=${key}`));
    const reportBody = (reportRes.body || '').trim();
    if (!reportBody) {
      // ZAP returned an empty body — write a valid empty report so parseFindings won't crash
      logger.warn('[ZAP] Report response was empty — writing empty report stub');
      fs.writeFileSync(reportPath, JSON.stringify({ site: [] }), 'utf8');
    } else {
      // Verify it's valid JSON before persisting
      try { JSON.parse(reportBody); } catch {
        logger.warn('[ZAP] Report response is not valid JSON — writing empty report stub');
        fs.writeFileSync(reportPath, JSON.stringify({ site: [] }), 'utf8');
      }
      fs.writeFileSync(reportPath, reportBody, 'utf8');
    }
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

// ─── Authenticated session ────────────────────────────────────────────────────

/**
 * Logs in to the application and returns a session cookie string for authenticated scans.
 * @param {string} targetUrl
 * @returns {string} Cookie string (may be empty if login fails)
 */
async function getAuthSession(targetUrl) {
  try {
    const loginPage = await httpGet(`${targetUrl}/web/index.php/auth/login`);
    const preCookie = buildCookieString(loginPage.headers['set-cookie']);
    const body = 'txtUsername=Admin&txtPassword=admin123';
    const loginRes = await httpPost(
      `${targetUrl}/web/index.php/auth/validateCredentials`,
      body,
      { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: preCookie }
    );
    const postCookie = buildCookieString(loginRes.headers['set-cookie']);
    const session = postCookie || preCookie;
    if (session) {
      logger.info('[SecExecution] Auth session established successfully');
    } else {
      logger.info('[SecExecution] Auth login returned no session cookie — continuing unauthenticated');
    }
    return session;
  } catch (err) {
    logger.info(`[SecExecution] Auth session unavailable: ${err.message} — continuing unauthenticated`);
    return '';
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

// ─── 8 Additional OWASP custom checks ────────────────────────────────────────

async function checkHttpMethodsAllowed(targetUrl) {
  const res = await safeGet(targetUrl);
  const allowHeader = res.headers['allow'] || res.headers['access-control-allow-methods'] || '';
  const dangerousMethods = ['TRACE', 'PUT', 'DELETE', 'CONNECT'];
  const found = dangerousMethods.filter(m => allowHeader.toUpperCase().includes(m));
  // Also probe TRACE directly
  let traceReflected = false;
  try {
    const traceRes = await new Promise(resolve => {
      const u = new URL(targetUrl);
      const mod2 = u.protocol === 'https:' ? https : http;
      const req = mod2.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname || '/', method: 'TRACE',
        headers: { 'X-Custom-Probe': 'zapprobe-trace' },
      }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve({ statusCode: r.statusCode, body: b })); });
      req.setTimeout(5000, () => { req.destroy(); resolve({ statusCode: 0, body: '' }); });
      req.on('error', () => resolve({ statusCode: 0, body: '' }));
      req.end();
    });
    traceReflected = traceRes.statusCode === 200 && traceRes.body.includes('X-Custom-Probe');
  } catch { /* ignore */ }
  const passed = found.length === 0 && !traceReflected;
  return {
    name:        'http-methods-allowed',
    passed,
    severity:    passed ? 'informational' : 'medium',
    cvss:        passed ? 0 : 5.3,
    owaspId:     'A05:2021',
    description: passed
      ? 'No dangerous HTTP methods detected'
      : `Dangerous HTTP methods: ${[...found, ...(traceReflected ? ['TRACE (reflected)'] : [])].join(', ')}`,
    evidence:    allowHeader ? `Allow: ${allowHeader}` : (traceReflected ? 'TRACE reflected back' : ''),
  };
}

async function checkServerVersionDisclosure(targetUrl) {
  const res = await safeGet(targetUrl);
  const server  = res.headers['server'] || '';
  const powered = res.headers['x-powered-by'] || '';
  const leaksServer  = /[\d]+\.[\d]+/.test(server);
  const leaksPowered = powered.length > 0;
  const passed = !leaksServer && !leaksPowered;
  return {
    name:        'server-version-disclosure',
    passed,
    severity:    passed ? 'informational' : 'low',
    cvss:        passed ? 0 : 3.7,
    owaspId:     'A05:2021',
    description: passed
      ? 'No server version information disclosed'
      : 'Server version/technology disclosed — assists attacker reconnaissance',
    evidence:    [server && `Server: ${server}`, powered && `X-Powered-By: ${powered}`].filter(Boolean).join(' | '),
  };
}

async function checkCorsMisconfiguration(targetUrl) {
  const res  = await safeGet(targetUrl, { Origin: 'https://evil.com' });
  const acao = res.headers['access-control-allow-origin'] || '';
  const acac = (res.headers['access-control-allow-credentials'] || '').toLowerCase();
  const reflectsEvil = acao === 'https://evil.com';
  const allowsCreds  = acac === 'true';
  const passed = !(reflectsEvil && allowsCreds);
  return {
    name:        'cors-misconfiguration',
    passed,
    severity:    passed ? 'informational' : 'high',
    cvss:        passed ? 0 : 7.5,
    owaspId:     'A05:2021',
    description: passed
      ? 'CORS policy does not allow arbitrary origins with credentials'
      : 'CORS misconfiguration: arbitrary origin reflected with credentials allowed',
    evidence:    `Access-Control-Allow-Origin: ${acao || '(none)'} | Allow-Credentials: ${acac || '(none)'}`,
  };
}

async function checkClickjackingProtection(targetUrl) {
  const res = await safeGet(targetUrl);
  const xfo = res.headers['x-frame-options'] || '';
  const csp = res.headers['content-security-policy'] || '';
  const passed = /DENY|SAMEORIGIN/i.test(xfo) || /frame-ancestors/i.test(csp);
  return {
    name:        'clickjacking-protection',
    passed,
    severity:    passed ? 'informational' : 'medium',
    cvss:        passed ? 0 : 4.3,
    owaspId:     'A05:2021',
    description: passed
      ? 'Clickjacking protection present (X-Frame-Options or CSP frame-ancestors)'
      : 'Missing clickjacking protection — page can be embedded in an attacker iframe',
    evidence:    xfo ? `X-Frame-Options: ${xfo}` : (csp ? `CSP: ${csp.slice(0, 80)}` : 'No X-Frame-Options or frame-ancestors found'),
  };
}

async function checkDirectoryTraversal(targetUrl) {
  const payloads = [
    `${targetUrl}/web/index.php/../../../etc/passwd`,
    `${targetUrl}/web/index.php?file=../../../etc/passwd`,
    `${targetUrl}/web/..%2F..%2F..%2Fetc%2Fpasswd`,
  ];
  for (const url of payloads) {
    const res = await safeGet(url);
    if (res.statusCode === 200 && /root:|nobody:|daemon:/i.test(res.body)) {
      return {
        name: 'directory-traversal-signal', passed: false, severity: 'critical', cvss: 9.1,
        owaspId: 'A01:2021',
        description: 'Directory traversal: /etc/passwd content returned',
        evidence: `URL: ${url} | Snippet: ${res.body.slice(0, 100)}`,
      };
    }
  }
  return { name: 'directory-traversal-signal', passed: true, severity: 'informational', cvss: 0, owaspId: 'A01:2021', description: 'No directory traversal detected', evidence: '' };
}

async function checkUserEnumeration(targetUrl) {
  const loginUrl = `${targetUrl}/web/index.php/auth/validateCredentials`;
  const h = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const validRes   = await safePost(loginUrl, 'txtUsername=Admin&txtPassword=wrongpassword', h);
  const invalidRes = await safePost(loginUrl, 'txtUsername=nonexistentuser99999&txtPassword=wrongpassword', h);
  const bodyDiff   = Math.abs((validRes.body || '').length - (invalidRes.body || '').length);
  const statusDiff = validRes.statusCode !== invalidRes.statusCode;
  const vuln = statusDiff || bodyDiff > 50;
  return {
    name:        'user-enumeration',
    passed:      !vuln,
    severity:    vuln ? 'medium' : 'informational',
    cvss:        vuln ? 5.3 : 0,
    owaspId:     'A07:2021',
    description: vuln
      ? `User enumeration possible: different responses for valid vs invalid username (status diff: ${statusDiff}, body diff: ${bodyDiff}B)`
      : 'Consistent responses for valid and invalid usernames',
    evidence:    `Valid → ${validRes.statusCode} (${(validRes.body||'').length}B) | Invalid → ${invalidRes.statusCode} (${(invalidRes.body||'').length}B)`,
  };
}

async function checkPasswordPolicyEnforcement(targetUrl) {
  const changePageRes = await safeGet(`${targetUrl}/web/index.php/pim/updatePasswordPage`);
  const hasPolicy = /minlength|min-length|minimum.*password|password.*must|at least/i.test(changePageRes.body);
  const resetRes  = await safePost(
    `${targetUrl}/web/index.php/auth/sendPasswordReset`,
    'email=admin@example.com',
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
  return {
    name:        'password-policy-enforcement',
    passed:      hasPolicy,
    severity:    hasPolicy ? 'informational' : 'low',
    cvss:        hasPolicy ? 0 : 3.1,
    owaspId:     'A07:2021',
    description: hasPolicy
      ? 'Password policy enforcement indicators found'
      : 'No password policy enforcement found in UI — weak passwords may be accepted',
    evidence:    `Password reset endpoint → HTTP ${resetRes.statusCode}`,
  };
}

async function checkInformationDisclosureErrors(targetUrl) {
  const probeUrls = [
    `${targetUrl}/web/index.php/nonexistentpage`,
    `${targetUrl}/web/index.php/pim/viewEmployeeList?empId=999999999`,
    `${targetUrl}/api/nonexistent`,
  ];
  const STACK_PATTERNS = [
    /stack trace|stacktrace/i,
    /\.php on line \d+|Fatal error/i,
    /Exception in thread|Traceback \(most/i,
    /\/var\/www|\/home\/\w|C:\\inetpub|C:\\xampp/i,
  ];
  for (const url of probeUrls) {
    const res = await safeGet(url);
    const found = STACK_PATTERNS.filter(p => p.test(res.body));
    if (found.length > 0) {
      return {
        name: 'information-disclosure-errors', passed: false, severity: 'medium', cvss: 5.3,
        owaspId: 'A05:2021',
        description: 'Stack trace or internal path disclosed in error response',
        evidence: `URL: ${url} | Patterns: ${found.map(p => p.source).join(', ')}`,
      };
    }
  }
  return { name: 'information-disclosure-errors', passed: true, severity: 'informational', cvss: 0, owaspId: 'A05:2021', description: 'No stack traces or internal paths in error responses', evidence: '' };
}

// Registry of all custom checks
const CUSTOM_CHECK_REGISTRY = {
  'missing-security-headers':       (url, cookies) => checkMissingSecurityHeaders(url),
  'insecure-cookie-flags':          (url, cookies) => checkInsecureCookieFlags(url),
  'session-fixation':               (url, cookies) => checkSessionFixation(url),
  'open-redirect':                  (url, cookies) => checkOpenRedirect(url),
  'sensitive-data-in-response':     checkSensitiveDataInResponse,
  'csrf-token-absence':             checkCsrfTokenAbsence,
  'idor-employee-id':               checkIdorEmployeeId,
  'sql-injection-signal':           (url, cookies) => checkSqlInjectionSignal(url),
  'xss-reflection-signal':          (url, cookies) => checkXssReflectionSignal(url),
  'broken-auth-brute-force':        (url, cookies) => checkBrokenAuthBruteForce(url),
  'http-methods-allowed':           (url, cookies) => checkHttpMethodsAllowed(url),
  'server-version-disclosure':      (url, cookies) => checkServerVersionDisclosure(url),
  'cors-misconfiguration':          (url, cookies) => checkCorsMisconfiguration(url),
  'clickjacking-protection':        (url, cookies) => checkClickjackingProtection(url),
  'directory-traversal-signal':     (url, cookies) => checkDirectoryTraversal(url),
  'user-enumeration':               (url, cookies) => checkUserEnumeration(url),
  'password-policy-enforcement':    (url, cookies) => checkPasswordPolicyEnforcement(url),
  'information-disclosure-errors':  (url, cookies) => checkInformationDisclosureErrors(url),
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

// ─── OWASP / CWE / Remediation enrichment data ───────────────────────────────

const OWASP_NAMES = {
  'A01:2021': 'Broken Access Control',
  'A02:2021': 'Cryptographic Failures',
  'A03:2021': 'Injection',
  'A04:2021': 'Insecure Design',
  'A05:2021': 'Security Misconfiguration',
  'A06:2021': 'Vulnerable & Outdated Components',
  'A07:2021': 'Identification & Authentication Failures',
  'A08:2021': 'Software & Data Integrity Failures',
  'A09:2021': 'Security Logging & Monitoring Failures',
  'A10:2021': 'Server-Side Request Forgery',
};

// Per-check enrichment: CWE, CVSS vector, remediation steps, priority, references
const CHECK_ENRICHMENT = {
  'missing-security-headers': {
    cwe: 'CWE-693', cweName: 'Protection Mechanism Failure',
    cvssVector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
    steps: [
      'Add Content-Security-Policy header with a restrictive policy to all responses.',
      'Set X-Content-Type-Options: nosniff on all responses to prevent MIME sniffing.',
      'Set X-Frame-Options: DENY or use CSP frame-ancestors directive.',
      'Enable Strict-Transport-Security (HSTS) with max-age=31536000; includeSubDomains.',
      'Set Referrer-Policy: strict-origin-when-cross-origin.',
      'Define Permissions-Policy to restrict unused browser features.',
    ],
    remediation: { priority: 'P1',
      shortTermFix: 'Add the missing security headers via web server or reverse proxy configuration (nginx/Apache/IIS).',
      permanentFix: 'Implement a global security-headers middleware in the application framework applied to every response.' },
    references: [
      { label: 'OWASP Secure Headers Project', url: 'https://owasp.org/www-project-secure-headers/' },
      { label: 'CWE-693', url: 'https://cwe.mitre.org/data/definitions/693.html' },
      { label: 'OWASP A05:2021', url: 'https://owasp.org/Top10/A05_2021-Security_Misconfiguration/' },
    ],
  },
  'insecure-cookie-flags': {
    cwe: 'CWE-614', cweName: 'Sensitive Cookie in HTTPS Session Without Secure Attribute',
    cvssVector: 'AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:N/A:N',
    steps: [
      'Set the Secure flag on all authentication and session cookies.',
      'Set the HttpOnly flag to prevent JavaScript access to session cookies.',
      'Set SameSite=Strict or SameSite=Lax to mitigate CSRF via cookie leakage.',
      'Audit cookie expiry values; ensure idle session timeout is enforced server-side.',
    ],
    remediation: { priority: 'P1',
      shortTermFix: 'Add Secure, HttpOnly, and SameSite=Strict to all session cookie Set-Cookie directives.',
      permanentFix: 'Centralise cookie creation in an authentication middleware that enforces all flags automatically.' },
    references: [
      { label: 'OWASP Session Management', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html' },
      { label: 'CWE-614', url: 'https://cwe.mitre.org/data/definitions/614.html' },
    ],
  },
  'session-fixation': {
    cwe: 'CWE-384', cweName: 'Session Fixation',
    cvssVector: 'AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:N',
    steps: [
      'Regenerate the session ID immediately after successful authentication.',
      'Invalidate any pre-authentication session tokens on login.',
      'Use a cryptographically secure session ID generator (minimum 128-bit entropy).',
      'Bind the session to IP and User-Agent as an additional heuristic check.',
    ],
    remediation: { priority: 'P0',
      shortTermFix: 'Regenerate the session token on successful login in the authentication handler.',
      permanentFix: 'Use a well-tested session management library that automatically regenerates IDs on privilege changes.' },
    references: [
      { label: 'OWASP A07:2021', url: 'https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/' },
      { label: 'CWE-384', url: 'https://cwe.mitre.org/data/definitions/384.html' },
    ],
  },
  'open-redirect': {
    cwe: 'CWE-601', cweName: 'URL Redirection to Untrusted Site (Open Redirect)',
    cvssVector: 'AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N',
    steps: [
      'Validate all redirect destinations against a strict allowlist of trusted domains.',
      'Reject any redirect URL containing an external hostname or scheme other than https.',
      'Use indirect redirects: map a token/ID to a server-side known-safe URL.',
    ],
    remediation: { priority: 'P1',
      shortTermFix: 'Block all redirects to external origins at the application layer.',
      permanentFix: 'Implement a redirect allowlist: only permit predefined internal paths or explicitly trusted domains.' },
    references: [
      { label: 'CWE-601', url: 'https://cwe.mitre.org/data/definitions/601.html' },
      { label: 'OWASP Unvalidated Redirects', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html' },
    ],
  },
  'sensitive-data-in-response': {
    cwe: 'CWE-200', cweName: 'Exposure of Sensitive Information to an Unauthorized Actor',
    cvssVector: 'AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N',
    steps: [
      'Define an explicit API response schema and strip all unlisted fields before serialisation.',
      'Remove PII (salary, SSN, national ID, tokens) from API responses via a serialisation allowlist.',
      'Implement RBAC: restrict sensitive fields to authorised roles only (e.g., HR_ADMIN).',
      'Add field-level access control to the API/ORM layer.',
      'Conduct a full audit of all API endpoints for accidental data exposure.',
    ],
    remediation: { priority: 'P0',
      shortTermFix: 'Immediately strip sensitive fields from all API responses using a serialisation allowlist.',
      permanentFix: 'Implement field-level RBAC in the API layer with automated schema validation on all endpoints.' },
    references: [
      { label: 'OWASP A02:2021', url: 'https://owasp.org/Top10/A02_2021-Cryptographic_Failures/' },
      { label: 'CWE-200', url: 'https://cwe.mitre.org/data/definitions/200.html' },
    ],
  },
  'csrf-token-absence': {
    cwe: 'CWE-352', cweName: 'Cross-Site Request Forgery (CSRF)',
    cvssVector: 'AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:N',
    steps: [
      'Implement the synchroniser token pattern: include a CSRF token in all state-changing forms.',
      'Validate the CSRF token server-side on every POST/PUT/PATCH/DELETE request.',
      'Set SameSite=Strict on all session cookies as a secondary CSRF defence.',
      'Use the double-submit cookie pattern for stateless REST APIs.',
    ],
    remediation: { priority: 'P0',
      shortTermFix: 'Add CSRF token validation to all state-changing endpoints immediately.',
      permanentFix: 'Integrate a CSRF protection middleware into the framework layer and audit all form endpoints.' },
    references: [
      { label: 'OWASP CSRF Prevention', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html' },
      { label: 'CWE-352', url: 'https://cwe.mitre.org/data/definitions/352.html' },
    ],
  },
  'idor-employee-id': {
    cwe: 'CWE-639', cweName: 'Authorization Bypass Through User-Controlled Key',
    cvssVector: 'AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N',
    steps: [
      'Validate object ownership on every request against the authenticated user\'s security context.',
      'Replace sequential integer IDs with UUIDs or opaque tokens in all API URLs.',
      'Implement resource-level access-control checks in the API/service layer.',
      'Log all cross-user access attempts and alert on anomalies.',
    ],
    remediation: { priority: 'P0',
      shortTermFix: 'Add ownership validation checks to all resource-fetching endpoints before the next deployment.',
      permanentFix: 'Implement a reusable IDOR-guard middleware that verifies ownership on every resource type.' },
    references: [
      { label: 'OWASP A01:2021', url: 'https://owasp.org/Top10/A01_2021-Broken_Access_Control/' },
      { label: 'CWE-639', url: 'https://cwe.mitre.org/data/definitions/639.html' },
      { label: 'OWASP IDOR Prevention', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html' },
    ],
  },
  'sql-injection-signal': {
    cwe: 'CWE-89', cweName: 'Improper Neutralisation of Special Elements in an SQL Command',
    cvssVector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    steps: [
      'Use parameterised queries or prepared statements exclusively — never concatenate user input into SQL.',
      'Deploy an ORM with parameter binding for all database operations.',
      'Implement a Web Application Firewall (WAF) as an additional layer.',
      'Conduct an emergency audit of all SQL queries in the codebase using a SAST tool.',
    ],
    remediation: { priority: 'P0',
      shortTermFix: 'Replace all string-concatenated SQL queries with parameterised statements immediately.',
      permanentFix: 'Mandate ORM-level parameterised queries and add SAST scanning to the CI/CD pipeline to block raw SQL.' },
    references: [
      { label: 'OWASP A03:2021', url: 'https://owasp.org/Top10/A03_2021-Injection/' },
      { label: 'CWE-89', url: 'https://cwe.mitre.org/data/definitions/89.html' },
      { label: 'OWASP SQL Injection Prevention', url: 'https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html' },
    ],
  },
  'xss-reflection-signal': {
    cwe: 'CWE-79', cweName: 'Improper Neutralisation of Input During Web Page Generation',
    cvssVector: 'AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N',
    steps: [
      'HTML-encode all output that includes user-controlled data in HTML, attribute, and JS contexts.',
      'Implement a Content-Security-Policy that blocks inline scripts.',
      'Use a framework with built-in output encoding (React, Angular, Thymeleaf).',
      'Validate and sanitise all user input at the server side using an allowlist approach.',
    ],
    remediation: { priority: 'P0',
      shortTermFix: 'Encode all user-controlled output in the appropriate context (HTML, attribute, URL, JS).',
      permanentFix: 'Adopt a secure-by-default templating engine and add DAST XSS scanning in the CI/CD pipeline.' },
    references: [
      { label: 'OWASP A03:2021', url: 'https://owasp.org/Top10/A03_2021-Injection/' },
      { label: 'CWE-79', url: 'https://cwe.mitre.org/data/definitions/79.html' },
      { label: 'OWASP XSS Prevention', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html' },
    ],
  },
  'broken-auth-brute-force': {
    cwe: 'CWE-307', cweName: 'Improper Restriction of Excessive Authentication Attempts',
    cvssVector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
    steps: [
      'Lock accounts for 15 minutes after 5 consecutive failed login attempts.',
      'Apply rate limiting: max 10 login requests per minute per IP address.',
      'Introduce a CAPTCHA challenge after 3 failed attempts.',
      'Alert the security team when > 20 failures per minute originate from a single IP.',
    ],
    remediation: { priority: 'P0',
      shortTermFix: 'Enable account lockout and IP-level rate limiting on the login endpoint immediately.',
      permanentFix: 'Implement a centralised authentication throttling service with alerting, CAPTCHA, and geo-blocking.' },
    references: [
      { label: 'OWASP A07:2021', url: 'https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/' },
      { label: 'CWE-307', url: 'https://cwe.mitre.org/data/definitions/307.html' },
    ],
  },
  'http-methods-allowed': {
    cwe: 'CWE-16', cweName: 'Configuration',
    cvssVector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
    steps: [
      'Disable TRACE and TRACK HTTP methods in the web server configuration.',
      'Restrict allowed methods per endpoint to GET, POST, PUT, DELETE as required.',
      'Return 405 Method Not Allowed for all unsupported HTTP methods.',
    ],
    remediation: { priority: 'P2',
      shortTermFix: 'Disable TRACE/TRACK and restrict methods in the server or API-gateway config.',
      permanentFix: 'Implement a request-method allowlist at the API gateway or ingress layer.' },
    references: [
      { label: 'OWASP A05:2021', url: 'https://owasp.org/Top10/A05_2021-Security_Misconfiguration/' },
      { label: 'CWE-16', url: 'https://cwe.mitre.org/data/definitions/16.html' },
    ],
  },
  'server-version-disclosure': {
    cwe: 'CWE-200', cweName: 'Exposure of Sensitive Information to an Unauthorized Actor',
    cvssVector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
    steps: [
      'Configure the web server to suppress the Server and X-Powered-By response headers.',
      'Remove framework and platform version strings from error pages and meta tags.',
      'Set a generic or absent Server header value in the server configuration.',
    ],
    remediation: { priority: 'P2',
      shortTermFix: 'Remove or suppress Server and X-Powered-By headers in the server configuration immediately.',
      permanentFix: 'Implement a response sanitisation middleware that strips all version-revealing headers globally.' },
    references: [
      { label: 'OWASP A05:2021', url: 'https://owasp.org/Top10/A05_2021-Security_Misconfiguration/' },
      { label: 'CWE-200', url: 'https://cwe.mitre.org/data/definitions/200.html' },
    ],
  },
  'cors-misconfiguration': {
    cwe: 'CWE-346', cweName: 'Origin Validation Error',
    cvssVector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N',
    steps: [
      'Replace wildcard or reflected-origin CORS with an explicit trusted-domain allowlist.',
      'Never programmatically mirror the request Origin header as Access-Control-Allow-Origin.',
      'Remove Access-Control-Allow-Credentials: true unless strictly required.',
      'Audit all API endpoints to verify CORS policy consistency.',
    ],
    remediation: { priority: 'P1',
      shortTermFix: 'Replace wildcard CORS config with an explicit origin allowlist.',
      permanentFix: 'Centralise CORS policy in the API gateway with domain allowlisting and credential controls.' },
    references: [
      { label: 'OWASP CORS', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Cross-Origin_Resource_Sharing_Cheat_Sheet.html' },
      { label: 'CWE-346', url: 'https://cwe.mitre.org/data/definitions/346.html' },
    ],
  },
  'clickjacking-protection': {
    cwe: 'CWE-1021', cweName: 'Improper Restriction of Rendered UI Layers or Frames',
    cvssVector: 'AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N',
    steps: [
      'Set X-Frame-Options: DENY on all page responses.',
      'Add Content-Security-Policy: frame-ancestors \'none\' for stronger browser support.',
      'Test by attempting to iframe the application from an external origin.',
    ],
    remediation: { priority: 'P2',
      shortTermFix: 'Add X-Frame-Options: DENY header to all responses via server configuration.',
      permanentFix: 'Add frame-ancestors \'none\' to the Content-Security-Policy header on all pages.' },
    references: [
      { label: 'CWE-1021', url: 'https://cwe.mitre.org/data/definitions/1021.html' },
      { label: 'OWASP Clickjacking Defence', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html' },
    ],
  },
  'directory-traversal-signal': {
    cwe: 'CWE-22', cweName: 'Improper Limitation of a Pathname to a Restricted Directory',
    cvssVector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    steps: [
      'Canonicalise all file paths and verify they resolve within the allowed base directory.',
      'Reject any path input containing ../ or ..%2f sequences before processing.',
      'Run the file-serving process with the minimum filesystem permissions required (principle of least privilege).',
      'Consider containerised filesystem isolation (chroot/Docker volumes).',
    ],
    remediation: { priority: 'P0',
      shortTermFix: 'Add path canonicalisation and traversal-sequence detection to all file-access endpoints immediately.',
      permanentFix: 'Use a sandboxed file service with filesystem isolation; enforce allowlisted paths only.' },
    references: [
      { label: 'OWASP A01:2021', url: 'https://owasp.org/Top10/A01_2021-Broken_Access_Control/' },
      { label: 'CWE-22', url: 'https://cwe.mitre.org/data/definitions/22.html' },
    ],
  },
  'user-enumeration': {
    cwe: 'CWE-204', cweName: 'Observable Response Discrepancy',
    cvssVector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
    steps: [
      'Return identical HTTP status codes, body content, and response times for valid and invalid usernames.',
      'Use a generic error message ("Invalid credentials") that does not reveal whether a username exists.',
      'Add CAPTCHA on login and password-reset endpoints.',
      'Rate-limit all authentication endpoints.',
    ],
    remediation: { priority: 'P1',
      shortTermFix: 'Normalise authentication error messages and response times to prevent username guessing.',
      permanentFix: 'Centralise authentication error handling to guarantee uniform responses for all failure cases.' },
    references: [
      { label: 'OWASP A07:2021', url: 'https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/' },
      { label: 'CWE-204', url: 'https://cwe.mitre.org/data/definitions/204.html' },
    ],
  },
  'password-policy-enforcement': {
    cwe: 'CWE-521', cweName: 'Weak Password Requirements',
    cvssVector: 'AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N',
    steps: [
      'Enforce minimum password length of 12 characters.',
      'Require complexity: upper/lowercase letters, digits, and special characters.',
      'Check passwords against known-breached databases (Have I Been Pwned API).',
      'Enforce password history (last 10 passwords) and a maximum age policy.',
    ],
    remediation: { priority: 'P1',
      shortTermFix: 'Update the password validation logic to enforce minimum complexity requirements.',
      permanentFix: 'Integrate the HIBP API for breach checking and align with NIST SP 800-63B guidelines.' },
    references: [
      { label: 'OWASP A07:2021', url: 'https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/' },
      { label: 'CWE-521', url: 'https://cwe.mitre.org/data/definitions/521.html' },
      { label: 'NIST SP 800-63B', url: 'https://pages.nist.gov/800-63-3/sp800-63b.html' },
    ],
  },
  'information-disclosure-errors': {
    cwe: 'CWE-209', cweName: 'Generation of Error Message Containing Sensitive Information',
    cvssVector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
    steps: [
      'Configure all environments to display generic HTTP 500 error pages without stack traces.',
      'Implement a global exception handler that logs stack trace details server-side only.',
      'Remove all debug mode flags from production deployments.',
      'Sanitise error messages to exclude file paths, framework names, and version strings.',
    ],
    remediation: { priority: 'P1',
      shortTermFix: 'Disable debug mode and configure a generic error handler for all unhandled exceptions.',
      permanentFix: 'Implement a centralised error-handling middleware that logs internally but returns only safe messages to clients.' },
    references: [
      { label: 'OWASP A05:2021', url: 'https://owasp.org/Top10/A05_2021-Security_Misconfiguration/' },
      { label: 'CWE-209', url: 'https://cwe.mitre.org/data/definitions/209.html' },
    ],
  },
};

/** Apply OWASP name, CWE, CVSS vector, steps, remediation, and references to a finding. */
function enrichFinding(f) {
  // OWASP category name
  if (!f.owaspName && f.owaspId) {
    const key = f.owaspId.includes(':') ? f.owaspId : f.owaspId + ':2021';
    f.owaspName = OWASP_NAMES[key] || f.owaspId;
  }
  const en = CHECK_ENRICHMENT[f.name] || {};
  if (en.cwe         && !f.cwe)         f.cwe         = en.cwe;
  if (en.cweName     && !f.cweName)     f.cweName     = en.cweName;
  if (en.cvssVector  && !f.cvssVector)  f.cvssVector  = en.cvssVector;
  if (en.steps       && !f.steps)       f.steps       = en.steps;
  if (en.remediation && !f.remediation) f.remediation = en.remediation;
  if (en.references  && !f.references)  f.references  = en.references;
  // Source label for display
  if (!f.source) f.source = 'custom';
  // Status default
  if (!f.status) f.status = 'new';
  return f;
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
        const raw  = (fs.readFileSync(zapJsonPath, 'utf8') || '').trim();
        if (!raw) {
          logger.info('[SecExecution] ZAP report file is empty — no ZAP findings to parse');
          return { findings: [], summary: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 } };
        }
        const data = JSON.parse(raw);
        // Collect alerts from ALL sites in the report (not just site[0])
        const sites  = Array.isArray(data.site) ? data.site : (data.site ? [data.site] : []);
        const alerts = data.alerts || sites.flatMap(s => Array.isArray(s.alerts) ? s.alerts : []);
        for (const alert of alerts) {
          const f = {
            id:          `ZAP-${idCounter++}`,
            source:      'zap',
            name:        alert.name || alert.alert || 'Unknown',
            severity:    zapRiskToSeverity(alert.riskcode),
            cvss:        parseFloat(alert.riskdesc?.split(' ')[0] || '0') || 0,
            owaspId:     alert.owaspid || 'A05:2021',
            owaspName:   OWASP_NAMES[alert.owaspid] || OWASP_NAMES['A05:2021'],
            cwe:         alert.cweid   ? `CWE-${alert.cweid}`   : null,
            cweName:     alert.wascid  ? `WASC-${alert.wascid}` : null,
            description: alert.desc || alert.description || '',
            evidence:    (alert.instances?.[0]?.evidence || alert.evidence || '').slice(0, 500),
            url:         alert.instances?.[0]?.uri || alert.url || '',
            solution:    alert.solution || '',
            status:      'new',
          };
          // Map ZAP solution field to remediation short-term fix
          if (f.solution && !f.remediation) {
            f.remediation = { priority: 'P2', shortTermFix: f.solution.replace(/<[^>]+>/g, '').trim() };
          }
          enrichFinding(f);
          findings.push(f);
        }
      } catch (e) {
        logger.warn(`[SecExecution] Could not parse ZAP report: ${e.message}`);
      }
    }

    // Add custom check findings (only failures)
    for (const r of customResults) {
      if (!r.passed) {
        const f = {
          id:          `CUSTOM-${idCounter++}`,
          source:      'custom',
          name:        r.name,
          severity:    r.severity,
          cvss:        r.cvss || 0,
          owaspId:     r.owaspId || 'A05:2021',
          description: r.description || '',
          evidence:    (r.evidence || '').slice(0, 500),
          url:         r.url || '',
          status:      'new',
        };
        enrichFinding(f);
        findings.push(f);
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

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION C — PENTEST ZAP ENHANCEMENTS (additive — no existing functions modified)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Scanner IDs to enable in the custom pentest scan policy.
 * These cover injection, XSS, XXE, SSRF, path traversal, deserialization, etc.
 */
const PENTEST_SCANNER_IDS = [
  40018, 40019, 40020, 40021, 40022, 40023, 40024, 40025, 40026, 40027,
  40028, 40029, 40031, 40032, 40034, 40035, 40036, 40038, 40039, 40040,
  40041, 40042, 40043, 40044, 40045, 90019, 90020, 90021, 90022, 90023,
  90024, 90025, 90026, 90027, 90028, 90030,
];

/**
 * C1 — Create a custom ZAP scan policy with all PENTEST_SCANNER_IDS enabled
 * at strength=HIGH, threshold=MEDIUM.
 *
 * @param {string} policyName - Name to give the new scan policy
 * @returns {Promise<string>} - policyName on success
 */
async function configureZapScanPolicy(policyName) {
  try {
    // Add the policy
    await httpPost(
      zapUrl('/JSON/ascan/action/addScanPolicy/'),
      '',
      {}
    ).catch(() => {}); // POST with query params — use GET-compatible helper below

    await retry(() => httpGet(
      zapUrl(`/JSON/ascan/action/addScanPolicy/?apikey=${encodeURIComponent(zapApiKey())}` +
             `&scanPolicyName=${encodeURIComponent(policyName)}`)
    ), 3, 1000);

    // Enable each scanner at strength=HIGH, threshold=MEDIUM
    for (const scannerId of PENTEST_SCANNER_IDS) {
      try {
        await httpGet(
          zapUrl('/JSON/ascan/action/setScanner/') +
          `?apikey=${encodeURIComponent(zapApiKey())}` +
          `&id=${scannerId}&scanPolicyName=${encodeURIComponent(policyName)}` +
          `&strength=HIGH&threshold=MEDIUM`
        );
      } catch (e) {
        logger.debug(`[ZAP-Policy] Could not set scanner ${scannerId}: ${e.message}`);
      }
    }

    logger.info(`[ZAP-Policy] Scan policy "${policyName}" created with ${PENTEST_SCANNER_IDS.length} scanners at HIGH/MEDIUM`);
    return policyName;
  } catch (err) {
    throw new AppError(`configureZapScanPolicy failed: ${err.message}`);
  }
}

/**
 * C2 — Configure ZAP to accept self-signed TLS certificates.
 * Controlled by ZAP_IGNORE_SSL_ERRORS=true in .env.
 *
 * @returns {Promise<void>}
 */
async function setZapHttpsEnabled() {
  if (process.env.ZAP_IGNORE_SSL_ERRORS !== 'true') {
    logger.info('[ZAP-SSL] ZAP_IGNORE_SSL_ERRORS is not true — skipping SSL relaxation');
    return;
  }
  try {
    await retry(() => httpGet(
      zapUrl('/JSON/network/action/setRootCaCertEnabled/') +
      `?apikey=${encodeURIComponent(zapApiKey())}&enabled=true`
    ), 3, 1000);
    logger.info('[ZAP-SSL] ZAP configured to accept self-signed certificates');
  } catch (err) {
    logger.warn(`[ZAP-SSL] Could not configure SSL acceptance: ${err.message}`);
  }
}

/**
 * C3 — Export the ZAP scan report in the requested format.
 *
 * @param {string} outputDir - Directory to write the report to
 * @param {'json'|'html'|'xml'} format - Report format
 * @returns {Promise<string>} - Absolute path to written file
 */
async function exportZapReport(outputDir, format = 'json') {
  fs.mkdirSync(outputDir, { recursive: true });

  const formatMap = {
    json: '/OTHER/core/other/jsonreport/',
    html: '/OTHER/core/other/htmlreport/',
    xml:  '/OTHER/core/other/xmlreport/',
  };
  const endpoint = formatMap[format] || formatMap.json;
  const ext      = format === 'html' ? 'html' : format === 'xml' ? 'xml' : 'json';
  const outPath  = path.join(outputDir, `zap-report.${ext}`);

  try {
    const res = await retry(() => httpGet(
      zapUrl(endpoint) + `?apikey=${encodeURIComponent(zapApiKey())}`
    ), 3, 1500);

    fs.writeFileSync(outPath, res.body, 'utf8');
    logger.info(`[ZAP-Report] Exported ${format} report to ${outPath}`);
    return outPath;
  } catch (err) {
    throw new AppError(`exportZapReport failed: ${err.message}`);
  }
}

module.exports = {
  getAuthSession,
  startZap,
  runZapScan,
  stopZap,
  runCustomChecks,
  parseFindings,
  evaluateSeverity,
  syncToZephyrAndJira,
  runFullScan,
  // Pentest ZAP enhancements (Section C)
  configureZapScanPolicy,
  setZapHttpsEnabled,
  exportZapReport,
  PENTEST_SCANNER_IDS,
};
