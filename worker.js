'use strict';
// Standalone worker: runs the queued jobs (imports, OSM, IBP…) outside the web server.
// docker-compose runs it as the `worker` service (the app then sets EMBEDDED_WORKER=0).
//   node worker.js
const { createRepo } = require('./repo');
const { openSql } = require('./repo/sql');
const { migrate } = require('./repo/pg-migrate');
const { createQueue } = require('./queue');
const { createWorker } = require('./queue/worker');
const { appendLog } = require('./scripts/applog');

(async () => {
  const repo = createRepo();
  await migrate(repo.pool);
  const queue = createQueue(openSql({ pool: repo.pool }));
  const worker = createWorker({
    getQueue: () => queue,
    onFinish: (job, code, lines) => {
      const { summarize } = require('./queue/jobs');
      appendLog(code === 0 ? 'info' : 'error', job.type, `${job.type} ${code === 0 ? 'completado' : code === 130 ? 'cancelado' : 'fallido'}`,
        { job: job.id, ...summarize(lines, code) });
    },
  });
  worker.start();
  console.log(`[worker] ${worker.id} esperando trabajos (${repo.driver})`);

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, async () => {
      console.log('[worker] parando…');
      await worker.stop();
      await repo.close().catch(() => {});
      process.exit(0);
    });
  }
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
