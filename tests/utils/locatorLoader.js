'use strict';
const fs   = require('fs');
const path = require('path');

/**
 * Load a YAML locator file and return a plain object { key: selectorString }.
 * Supports simple `key: 'value'` or `key: value` lines. Ignores comments (#) and blanks.
 */
function loadLocators(ymlPath) {
  const abs  = path.isAbsolute(ymlPath) ? ymlPath : path.resolve(__dirname, '..', 'pages', ymlPath);
  const text = fs.readFileSync(abs, 'utf8');
  const map  = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val   = trimmed.slice(idx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    }
    map[key] = val;
  }
  return map;
}

module.exports = { loadLocators };
