import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.mjs';
import { startDurableWorker } from './worker.mjs';

/** Production-only background process; HTTP traffic is handled by api/index.mjs. */
export async function startDaemon({ createAppImpl = createApp, startWorkerImpl = startDurableWorker, intervalMs = 5000, shutdownGraceMs = 25000, onError = () => console.error('A worker cycle needs attention. Saved progress is retained.') } = {}) {
  if (!Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 1 || shutdownGraceMs > 25000) throw new Error('Choose a shutdown grace period from 1 to 25000 milliseconds.');
  const server = await createAppImpl({ dataDir: join(tmpdir(), 'changerelay-worker-sample'), sampleEphemeral: true });
  if (!server.liveService?.configured) throw new Error('The background worker requires complete server-side live configuration.');
  const worker = startWorkerImpl({ cycle: () => server.liveService.workerCycle(), intervalMs, onError });
  // worker.mjs intentionally unrefs its timer for web processes. This daemon owns its lifetime.
  const keepAlive = setInterval(() => {}, 2147483647);
  let stopping;
  return Object.freeze({
    stop() {
      stopping ||= (async () => {
        let deadline;
        try {
          return await Promise.race([
            Promise.resolve().then(() => worker.stop()).then(() => ({ drained: true })),
            new Promise(resolve => { deadline = setTimeout(() => resolve({ drained: false }), shutdownGraceMs); }),
          ]);
        } finally { clearTimeout(deadline); clearInterval(keepAlive); }
      })();
      return stopping;
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const daemon = await startDaemon();
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      try {
        const { drained } = await daemon.stop();
        if (!drained) console.error('Worker shutdown reached its deadline. Saved progress will be checked by the next worker.');
        process.exit(drained ? 0 : 1);
      } catch { console.error('Worker shutdown could not finish. Saved progress is retained.'); process.exit(1); }
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    console.log('ChangeRelay background worker is ready.');
  } catch { console.error('ChangeRelay background worker could not start. Check the server configuration.'); process.exitCode = 1; }
}
