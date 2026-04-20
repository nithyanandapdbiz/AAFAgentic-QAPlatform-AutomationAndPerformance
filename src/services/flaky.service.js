'use strict';
const MAX_HISTORY = 100;
const history = {};

function detectFlaky(name, passed) {
  if (!history[name]) history[name] = [];
  history[name].push(passed);
  if (history[name].length > MAX_HISTORY) history[name].shift();
  const last = history[name].slice(-5);
  return last.includes(true) && last.includes(false);
}
module.exports = { detectFlaky };
