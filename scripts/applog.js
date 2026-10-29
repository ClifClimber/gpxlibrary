'use strict';
// Operations log shown in Admin → Logs: one JSON line per event in data/logs/YYYY-MM-DD.log.
// Shared by the server and the worker.
const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'data', 'logs');
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch {}

function logFilePath(date) {
  return path.join(LOGS_DIR, `${date || new Date().toISOString().slice(0, 10)}.log`);
}

// Logs hold IPs and usernames: days older than KEEP_DAYS are deleted (checked once a day)
const KEEP_DAYS = 30;
let _prunedOn = null;
function pruneLogs() {
  const today = new Date().toISOString().slice(0, 10);
  if (_prunedOn === today) return;
  _prunedOn = today;
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
  try {
    for (const f of fs.readdirSync(LOGS_DIR)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && m[1] < cutoff) fs.unlinkSync(path.join(LOGS_DIR, f));
    }
  } catch {}
}

function appendLog(level, op, msg, extra = {}) {
  pruneLogs();
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, op, msg, ...extra });
  try { fs.appendFileSync(logFilePath(), entry + '\n'); } catch {}
}

module.exports = { LOGS_DIR, logFilePath, appendLog, pruneLogs };
