import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const MAX_BODY_BYTES = 50000;

/** Vercel's Node helpers may already have consumed and parsed the input stream. */
export function normalizeFunctionRequest(request) {
  if (request.method !== 'POST' || !String(request.url).startsWith('/api/')) return request;
  let body;
  // Vercel computes this helper lazily and throws when JSON parsing fails.
  try { body = request.body; }
  catch { throw Object.assign(new Error('Enter a valid request.'), { status: 400 }); }
  if (body === undefined) return request;
  const type = String(request.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw Object.assign(new Error('Send requests as JSON.'), { status: 415 });
  let raw;
  try {
    raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  } catch { throw Object.assign(new Error('Enter a valid request.'), { status: 400 }); }
  if (raw.length > MAX_BODY_BYTES) throw Object.assign(new Error('The request is too large.'), { status: 413 });
  const stream = Readable.from([raw]);
  // Preserve Node request headers, socket and URL; replace only the exhausted body iterator.
  const normalized = Object.create(request);
  Object.defineProperty(normalized, Symbol.asyncIterator, { value: stream[Symbol.asyncIterator].bind(stream) });
  return normalized;
}

/** A lazily initialized HTTP handler. It opens no socket and starts no worker. */
export function createVercelHandler({ createAppImpl = createApp, dataDir = join(tmpdir(), 'changerelay-sample') } = {}) {
  let appPromise;
  return async function handler(request, response) {
    try {
      const normalized = normalizeFunctionRequest(request);
      appPromise ||= Promise.resolve().then(() => createAppImpl({ dataDir, sampleEphemeral: true })).catch(error => { appPromise = null; throw error; });
      const server = await appPromise;
      const listener = server.listeners('request')[0];
      if (typeof listener !== 'function') throw new Error('HTTP handler unavailable.');
      // Await the listener itself: EventEmitter.emit would return before async work finishes.
      await listener.call(server, normalized, response);
    } catch (error) {
      if (response.headersSent || response.writableEnded) { if (!response.writableEnded) response.end(); return; }
      response.writeHead(error.status || 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify({ error: error.status ? error.message : 'The workspace could not start. Please try again.' }));
    }
  };
}

export default createVercelHandler();
