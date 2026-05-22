/// <reference lib="webworker" />
// Runs the (synchronous, multi-second on large feeds) GTFS parse off the main
// thread so the UI never freezes. Imports only the pure parser — no store, no
// browser-only globals. Driven by parseGtfsInWorker() in gtfsImport.ts.
import { importGtfsZip } from './gtfsParse';
import type { ImportWorkerRequest, ImportWorkerResponse } from './gtfsParse';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const post = (msg: ImportWorkerResponse) => ctx.postMessage(msg);

ctx.onmessage = async (e: MessageEvent<ImportWorkerRequest>) => {
  try {
    const data = await importGtfsZip(e.data.file, (p) =>
      post({ type: 'progress', phase: p.phase, rows: p.rows }),
    );
    post({ type: 'result', data });
  } catch (err) {
    post({
      type: 'error',
      message: err instanceof Error ? err.message : 'Failed to parse GTFS feed',
    });
  }
};
