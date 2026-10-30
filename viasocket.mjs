import { ViaSocket } from 'viasocket-apps';

const keys = ['VIASOCKET_ORG_ID', 'VIASOCKET_PROJECT_ID', 'VIASOCKET_EMBED_SECRET'];
export function viaSocketConfigured() {
  return keys.every(key => typeof process.env[key] === 'string' && process.env[key].trim());
}

export function createViaSocket() {
  if (!viaSocketConfigured()) throw new Error('The viaSocket project needs server configuration.');
  return new ViaSocket({
    orgId: process.env.VIASOCKET_ORG_ID,
    projectId: process.env.VIASOCKET_PROJECT_ID,
    secret: process.env.VIASOCKET_EMBED_SECRET,
    // A timed-out write is reconciled by its adapter; it is never blindly dispatched again.
    fetch: (url, options = {}) => fetch(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }),
  });
}
