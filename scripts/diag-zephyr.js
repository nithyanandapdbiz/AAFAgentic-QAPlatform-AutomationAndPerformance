'use strict';
require('dotenv').config();
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const ROOT         = path.resolve(__dirname, '..');
const RESULTS_FILE = path.join(ROOT, 'test-results.json');
const ZEPHYR_BASE  = process.env.ZEPHYR_BASE_URL || 'https://prod-api.zephyr4jiracloud.com/v2';
const ZEPHYR_TOKEN = process.env.ZEPHYR_ACCESS_KEY;
const PROJECT_KEY  = process.env.PROJECT_KEY || 'SCRUM';

function zHeaders() {
  return {
    Authorization:  ZEPHYR_TOKEN,
    'Content-Type': 'application/json',
    Accept:         'application/json'
  };
}

async function main() {
  console.log('=== Zephyr Sync Diagnostic ===\n');

  // 1. Check test-results.json
  console.log('--- Step 1: Parse test-results.json ---');
  if (!fs.existsSync(RESULTS_FILE)) {
    console.log('  ERROR: test-results.json not found. Run Playwright first.');
    return;
  }
  const raw = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));

  function collectTests(suites, parentFile) {
    const results = [];
    for (const suite of (suites || [])) {
      const file = suite.file || parentFile || '';
      const keyMatch  = path.basename(file).match(/^(SCRUM-T\d+)_/i);
      const zephyrKey = keyMatch ? keyMatch[1].toUpperCase() : null;
      if (suite.suites && suite.suites.length) {
        results.push(...collectTests(suite.suites, file));
      }
      for (const spec of (suite.specs || [])) {
        let finalStatus = 'Not Executed';
        if (Array.isArray(spec.tests) && spec.tests.length > 0) {
          const lastTest = spec.tests[spec.tests.length - 1];
          if (Array.isArray(lastTest.results) && lastTest.results.length > 0) {
            const lastResult = lastTest.results[lastTest.results.length - 1];
            const STATUS_MAP = { passed: 'Pass', failed: 'Fail', timedOut: 'Blocked', skipped: 'Not Executed' };
            finalStatus = STATUS_MAP[lastResult.status] || 'Fail';
          }
        }
        results.push({ zephyrKey, title: (spec.title || '').slice(0, 60), status: finalStatus });
      }
    }
    return results;
  }

  const allTests = collectTests(raw.suites || []);
  const byKey = new Map();
  for (const t of allTests) {
    if (!t.zephyrKey) continue;
    const prev = byKey.get(t.zephyrKey);
    if (!prev) byKey.set(t.zephyrKey, { status: t.status });
    else if (prev.status !== 'Fail' && t.status === 'Fail') byKey.set(t.zephyrKey, { status: 'Fail' });
  }

  console.log(`  Total tests parsed: ${allTests.length}`);
  console.log(`  Keys found in results: ${byKey.size}`);
  for (const [k, v] of byKey) console.log(`    ${k} => ${v.status}`);

  // 2. Fetch Zephyr test cases
  console.log('\n--- Step 2: Fetch Zephyr Test Cases ---');
  try {
    const res = await axios.get(`${ZEPHYR_BASE}/testcases`, {
      headers: zHeaders(),
      params:  { projectKey: PROJECT_KEY, maxResults: 100 }
    });
    const tcs = res.data.values || res.data || [];
    console.log(`  Zephyr returned ${tcs.length} test case(s)`);
    for (const tc of tcs) {
      const match = byKey.has(tc.key) ? 'MATCH' : 'NO MATCH';
      console.log(`    ${tc.key} - ${(tc.name || '').slice(0, 50)} [${match}]`);
    }
  } catch (err) {
    console.log(`  ERROR fetching TCs: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
    console.log(`  Status: ${err.response?.status}`);
    return;
  }

  // 3. Test creating a cycle and one execution
  console.log('\n--- Step 3: Test Create Cycle ---');
  let cycleKey;
  try {
    const res = await axios.post(`${ZEPHYR_BASE}/testcycles`, {
      projectKey: PROJECT_KEY,
      name: `DIAG-${new Date().toISOString().slice(0, 19)}`,
      description: 'Diagnostic test cycle'
    }, { headers: zHeaders() });
    console.log(`  Cycle response: ${JSON.stringify(res.data)}`);
    cycleKey = res.data.key;
  } catch (err) {
    console.log(`  ERROR creating cycle: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
    console.log(`  Status: ${err.response?.status}`);
    return;
  }

  // 4. Test creating an execution and updating it
  console.log('\n--- Step 4: Test Create & Update Execution ---');
  const firstKey = [...byKey.keys()][0];
  if (!firstKey) {
    console.log('  No matched keys to test with.');
    return;
  }
  console.log(`  Using TC key: ${firstKey}`);
  try {
    const res = await axios.post(`${ZEPHYR_BASE}/testexecutions`, {
      projectKey:   PROJECT_KEY,
      testCaseKey:  firstKey,
      testCycleKey: cycleKey,
      statusName:   'In Progress'
    }, { headers: zHeaders() });
    console.log(`  Create execution response: ${JSON.stringify(res.data)}`);
    const execId = res.data.id;
    const execKey = res.data.key;

    // Try update with numeric ID
    console.log(`\n  Updating execution (id=${execId}) to "Pass"...`);
    try {
      const upRes = await axios.put(`${ZEPHYR_BASE}/testexecutions/${execId}`, {
        statusName: 'Pass',
        comment: 'Diagnostic test'
      }, { headers: zHeaders() });
      console.log(`  Update by ID response status: ${upRes.status}`);
      console.log(`  Update by ID response data: ${JSON.stringify(upRes.data)}`);
    } catch (err) {
      console.log(`  ERROR updating by ID: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
      console.log(`  Status: ${err.response?.status}`);
    }

    // Also try reading it back
    console.log(`\n  Reading back execution ${execId}...`);
    try {
      const getRes = await axios.get(`${ZEPHYR_BASE}/testexecutions/${execId}`, {
        headers: zHeaders()
      });
      console.log(`  Execution status: ${getRes.data.testExecutionStatus?.name || getRes.data.statusName || JSON.stringify(getRes.data)}`);
    } catch (err) {
      console.log(`  ERROR reading execution: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
    }
  } catch (err) {
    console.log(`  ERROR creating execution: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
    console.log(`  Status: ${err.response?.status}`);
  }

  // 5. Fetch all execution statuses to see valid names
  console.log('\n--- Step 5: Fetch Execution Statuses ---');
  try {
    const res = await axios.get(`${ZEPHYR_BASE}/statuses`, {
      headers: zHeaders(),
      params: { projectKey: PROJECT_KEY, statusType: 'TEST_EXECUTION', maxResults: 50 }
    });
    const statuses = res.data.values || res.data || [];
    console.log(`  Found ${statuses.length} execution status(es):`);
    for (const s of statuses) {
      console.log(`    ID=${s.id}  name="${s.name}"  description="${s.description || ''}"  default=${s.default || false}`);
    }
  } catch (err) {
    console.log(`  ERROR: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
    console.log(`  Status: ${err.response?.status}`);
    // Fallback: try without params
    try {
      const res2 = await axios.get(`${ZEPHYR_BASE}/statuses`, { headers: zHeaders() });
      console.log(`  Fallback statuses: ${JSON.stringify(res2.data).slice(0, 500)}`);
    } catch (e2) {
      console.log(`  Fallback also failed: ${e2.response?.status} ${e2.message}`);
    }
  }

  // 6. Try updating with testExecutionStatus object instead of statusName
  console.log('\n--- Step 6: Test Alternative Update Formats ---');
  try {
    // Try with statusName "Pass" and read back
    const res1 = await axios.post(`${ZEPHYR_BASE}/testexecutions`, {
      projectKey: PROJECT_KEY,
      testCaseKey: firstKey,
      testCycleKey: cycleKey,
      statusName: 'Not Executed'
    }, { headers: zHeaders() });
    const eid = res1.data.id;
    console.log(`  Created new execution ${eid} with "Not Executed"`);

    // Read initial status
    const get1 = await axios.get(`${ZEPHYR_BASE}/testexecutions/${eid}`, { headers: zHeaders() });
    console.log(`  Initial status ID: ${get1.data.testExecutionStatus?.id}`);

    // Update with statusName
    await axios.put(`${ZEPHYR_BASE}/testexecutions/${eid}`, {
      statusName: 'Pass'
    }, { headers: zHeaders() });
    const get2 = await axios.get(`${ZEPHYR_BASE}/testexecutions/${eid}`, { headers: zHeaders() });
    console.log(`  After statusName="Pass" => status ID: ${get2.data.testExecutionStatus?.id}  (changed? ${get1.data.testExecutionStatus?.id !== get2.data.testExecutionStatus?.id})`);

    // Try with testExecutionStatus object
    await axios.put(`${ZEPHYR_BASE}/testexecutions/${eid}`, {
      testExecutionStatus: { name: 'Fail' }
    }, { headers: zHeaders() });
    const get3 = await axios.get(`${ZEPHYR_BASE}/testexecutions/${eid}`, { headers: zHeaders() });
    console.log(`  After testExecutionStatus.name="Fail" => status ID: ${get3.data.testExecutionStatus?.id}  (changed? ${get2.data.testExecutionStatus?.id !== get3.data.testExecutionStatus?.id})`);

  } catch (err) {
    console.log(`  ERROR: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
  }

  console.log('\n=== Diagnostic Complete ===');
}

main().catch(err => console.error('FATAL:', err));
