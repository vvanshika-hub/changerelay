const ROUTES = {
  '/api/auth/status': 'GET', '/api/auth/me': 'GET',
  '/api/auth/sign-in': 'POST', '/api/auth/sign-up': 'POST', '/api/auth/sign-out': 'POST',
};
function reply(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

/** Only safe JSON leaves this router. Session material is sent through Set-Cookie alone. */
export function createAuthRoutes({ service, now = () => Date.now() }) {
  const attempts = new Map();
  return async function authRoutes(request, response, url) {
    if (!url.pathname.startsWith('/api/auth/')) return false;
    try {
      const method = ROUTES[url.pathname];
      if (!method) { reply(response, 404, { error: 'Account action unavailable.' }); return true; }
      if (request.method !== method) { response.setHeader('Allow', method); reply(response, 405, { error: 'Method not allowed.' }); return true; }
      if (method === 'POST') {
        const origin = request.headers.origin;
        if (origin && ![`http://${request.headers.host}`, `https://${request.headers.host}`].includes(origin)) {
          reply(response, 403, { error: 'Request origin rejected.' }); return true;
        }
        if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          reply(response, 415, { error: 'Send account requests as JSON.' }); return true;
        }
      }
      if (!service?.configured) {
        reply(response, method === 'GET' ? 200 : 503, { configured: false, user: null, setup: { ready: false }, message: 'Account setup is still in progress. You can explore the sample workspace.' });
        return true;
      }
      if (url.pathname === '/api/auth/status') { reply(response, 200, { configured: true }); return true; }
      let body = {};
      if (method === 'POST') {
        const ip = request.socket?.remoteAddress || 'local';
        const key = `${ip}:${url.pathname}`, cutoff = now() - 600000;
        const recent = (attempts.get(key) || []).filter(value => value > cutoff);
        if (recent.length >= 12) { response.setHeader('Retry-After', '600'); reply(response, 429, { error: 'Too many account attempts. Please try again in a few minutes.' }); return true; }
        recent.push(now()); attempts.set(key, recent);
        if (attempts.size > 5000) for (const [entry, times] of attempts) if (!times.some(time => time > cutoff)) attempts.delete(entry);
        let raw = '';
        for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 10000) { reply(response, 413, { error: 'Account request too large.' }); return true; } }
        try { body = JSON.parse(raw || '{}'); } catch { reply(response, 400, { error: 'Enter a valid account request.' }); return true; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { reply(response, 400, { error: 'Enter a valid account request.' }); return true; }
      }
      let result;
      if (url.pathname === '/api/auth/sign-in') result = await service.signIn(body);
      else if (url.pathname === '/api/auth/sign-up') result = await service.signUp(body);
      else if (url.pathname === '/api/auth/sign-out') result = await service.signOut(request.headers.cookie || '');
      else result = await service.currentUser(request.headers.cookie || '');
      if (result.setCookie) response.setHeader('Set-Cookie', result.setCookie);
      const user = result.user ? { id: result.user.id, email: result.user.email, name: result.user.name || '' } : null;
      reply(response, 200, { configured: true, user, needsEmailConfirmation: result.needsEmailConfirmation === true });
    } catch (error) {
      if (error.setCookie) response.setHeader('Set-Cookie', error.setCookie);
      reply(response, error.status || 500, { error: error.status ? error.message : 'The account request could not be completed. Please try again.', code: error.code || 'ACCOUNT_REQUEST_FAILED' });
    }
    return true;
  };
}
