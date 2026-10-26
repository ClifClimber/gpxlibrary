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

function appendLog(level, op, msg, extra = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, op, msg, ...extra });
  try { fs.appendFileSync(logFilePath(), entry + '\n'); } catch {}
}

module.exports = { LOGS_DIR, logFilePath, appendLog };
