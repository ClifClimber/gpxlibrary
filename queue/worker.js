'use strict';
// Worker loop: claims jobs from the queue and runs each one as a child process (the script of its type),
// storing its output line by line, sending heartbeats and honouring cancellation.
// Used embedded in the server (local use) and standalone by worker.js (docker-compose service `worker`).
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { scriptOf, levelOf, summarize } = require('./jobs');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * getQueue: () => queue bound to the current database (the server can switch engines).
 * onFinish(job, code, lines): called after each run (logs, cache invalidation…).
 * isPaused: () => true while the server is switching engine or store.
 */
function createWorker({ getQueue, onFinish = () => {}, isPaused = () => false, pollMs = 1000, resolveScript = scriptOf,
  heartbeatMs = 5000, id = `${os.hostname()}-${process.pid}`, log = console }) {
  let running = false, current = null, stopping = false, lastHousekeeping = 0;

  async function housekeeping(queue) {
    if (Date.now() - lastHousekeeping < 30000) return;
    lastHousekeeping = Date.now();
    const n = await queue.recoverStale();
    if (n) log.log(`[worker] ${n} trabajos recuperados de un proceso detenido`);
    await queue.prune();
  }

  function run(queue, job) {
    return new Promise(resolve => {
      const script = resolveScript(job.type);
      const lines = [];
      let seq = 0, pending = [], buf = '', cancelled = false;
      const add = (text, level) => { lines.push(text); pending.push({ seq: ++seq, level: level || levelOf(text), text }); };
      const flush = async () => {
        if (!pending.length) return;
        const batch = pending; pending = [];
        try { await queue.log(job.id, batch); } catch (e) { log.error(`[worker] log job ${job.id}: ${e.message}`); }
      };

      if (!script) {
        add(`✗ Tipo de trabajo desconocido: ${job.type}`);
        return flush().then(() => queue.fail({ ...job, maxAttempts: 0 }, 'Tipo de trabajo desconocido')).then(() => resolve(1));
      }
      if (job.attempts > 1) add(`↻ Intento ${job.attempts} de ${job.maxAttempts}`);

      const child = spawn(process.execPath, [script, ...(job.payload.args || [])], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      current = { job, child, queue };
      child.stdout.on('data', chunk => {
        buf += chunk.toString().replace(/\r(?!\n)/g, '\n');
        const parts = buf.split('\n'); buf = parts.pop();
        parts.map(l => l.trim()).filter(Boolean).forEach(t => add(t));
      });
      child.stderr.on('data', chunk => chunk.toString().split('\n').map(l => l.trim()).filter(Boolean).forEach(t => add(t, 'error')));

      const flusher = setInterval(flush, 300);
      const beat = setInterval(async () => {
        try {
          if ((await queue.heartbeat(job.id)) === 'cancelling' && !cancelled) {
            cancelled = true;
            add('✗ Cancelado por el usuario');
            child.kill();
          }
        } catch (e) { log.error(`[worker] heartbeat job ${job.id}: ${e.message}`); }
      }, heartbeatMs);

      let finished = false;
      const finish = async code => {
        if (finished) return;
        finished = true;
        clearInterval(beat); clearInterval(flusher);
        if (buf.trim()) add(buf.trim());
        await flush();
        try {
          if (stopping && !cancelled && code !== 0) await queue.release(job.id);
          else if (cancelled) await queue.markCancelled(job.id);
          else if (code === 0) await queue.complete(job.id, summarize(lines, code));
          else if (await queue.fail(job, `Terminó con código ${code}`, summarize(lines, code))) {
            await queue.log(job.id, [{ seq: ++seq, level: 'warn', text: '⚠ Ha fallado; se reintentará más tarde' }]);
          }
        } catch (e) { log.error(`[worker] cerrar job ${job.id}: ${e.message}`); }
        current = null;
        try { await onFinish(job, cancelled ? 130 : code, lines); } catch (e) { log.error(`[worker] onFinish: ${e.message}`); }
        resolve(code);
      };
      child.on('close', code => finish(code ?? 1));
      child.on('error', e => { add(`✗ ${e.message}`); finish(1); });
    });
  }

  async function loop() {
    while (running) {
      try {
        if (isPaused()) { await sleep(pollMs); continue; }
        const queue = getQueue();
        await housekeeping(queue);
        const job = await queue.claim(id);
        if (!job) { await sleep(pollMs); continue; }
        log.log(`[worker] trabajo ${job.id} (${job.type}) iniciado`);
        const code = await run(queue, job);
        log.log(`[worker] trabajo ${job.id} (${job.type}) terminado con código ${code}`);
      } catch (e) {
        log.error(`[worker] ${e.message}`);
        await sleep(pollMs * 3);
      }
    }
  }

  return {
    id,
    start() { if (!running) { running = true; stopping = false; loop(); } },
    /** Stops claiming; a running job is interrupted and goes back to the queue. */
    async stop() {
      running = false;
      stopping = true;
      if (current) {
        current.child.kill();
        for (let i = 0; i < 50 && current; i++) await sleep(100);
      }
    },
    get busy() { return !!current; },
  };
}

module.exports = { createWorker };
