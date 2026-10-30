import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// Real Supabase authentication remains UNTESTED until a project is configured.
// Route handlers must send `setCookie` as a Set-Cookie header, never as a JSON field.
// Protect every modifying auth route with same-origin/CSRF checks and a rate limit.
export const AUTH_COOKIE_NAME = 'cr_auth';
const MAX_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// A provider outage must not leave an account request pending indefinitely.
// The SDK's documented global.fetch option carries this deadline through every auth call.
function boundedAuthFetch(input, init = {}) {
  const signals = [AbortSignal.timeout(15000)];
  if (input instanceof Request) signals.push(input.signal);
  if (init.signal) signals.push(init.signal);
  return globalThis.fetch(input, { ...init, signal: AbortSignal.any(signals) });
}

export class AuthError extends Error {
  constructor(status, code, message, setCookie = null) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
    if (setCookie) this.setCookie = setCookie;
  }
}

function endpoint(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.hash || parsed.search) return null;
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname))) return null;
    return parsed;
  } catch { return null; }
}

function keyBytes(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength === 32 ? Buffer.from(value) : null;
  if (typeof value !== 'string') return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (!/^[A-Za-z0-9_+/-]{43}=?$/.test(value)) return null;
  const result = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return result.length === 32 ? result : null;
}

function credentials(body, signUp) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthError(400, 'invalid_credentials', 'Enter your email and password.');
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError(400, 'invalid_email', 'Enter a valid email address.');
  if (typeof body.password !== 'string' || body.password.length < (signUp ? 8 : 1) || body.password.length > 128) {
    throw new AuthError(400, 'invalid_password', signUp ? 'Use a password between 8 and 128 characters.' : 'Enter your password, up to 128 characters.');
  }
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 80 || /[\u0000-\u001f\u007f]/.test(body.name))) throw new AuthError(400, 'invalid_name', 'Use a name under 80 characters.');
  return { email, password: body.password, name: body.name?.trim() || '' };
}

function providerFailure(error, operation) {
  const status = Number(error?.status);
  if (status === 429) return new AuthError(429, 'auth_rate_limited', 'Too many attempts. Please try again later.');
  if (operation === 'signin' && (status === 400 || status === 401)) return new AuthError(401, 'invalid_credentials', 'The email or password is incorrect, or the email needs confirmation.');
  if (operation === 'signup' && status >= 400 && status < 500) return new AuthError(400, 'signup_rejected', 'Sign-up could not be completed. Check the details or sign in to an existing account.');
  if (status >= 400 && status < 500) return new AuthError(401, 'session_invalid', 'Your session has ended. Please sign in again.');
  return new AuthError(503, 'auth_unavailable', 'Sign-in is temporarily unavailable. Please try again.');
}

function assertIdentity(user, expectedId) {
  if (!user || !UUID.test(user.id || '') || (expectedId && user.id !== expectedId)) throw new AuthError(401, 'session_invalid', 'Your session could not be verified. Please sign in again.');
  return user;
}

function safeUser(user, now) {
  assertIdentity(user);
  if (user.is_anonymous === true) throw new AuthError(403, 'account_required', 'Create a confirmed account to use a live workspace.');
  if (typeof user.email !== 'string' || !user.email || !Number.isFinite(Date.parse(user.email_confirmed_at || ''))) throw new AuthError(403, 'email_confirmation_required', 'Confirm your email address before using a live workspace.');
  if (user.deleted_at || (user.banned_until && Date.parse(user.banned_until) > now)) throw new AuthError(403, 'account_unavailable', 'This account cannot access the live workspace.');
  // Names are cosmetic only. Never use user_metadata for ownership, roles or permissions.
  const name = typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name.slice(0, 80) : typeof user.user_metadata?.name === 'string' ? user.user_metadata.name.slice(0, 80) : '';
  return Object.freeze({ id: user.id, email: user.email, name });
}

export function createAuthService({ url, publishableKey, sessionKey, appUrl, sessionRegistry = null, createClientImpl = createClient, now = () => Date.now() } = {}) {
  const providerUrl = endpoint(url), application = endpoint(appUrl), key = keyBytes(sessionKey);
  const missing = [];
  if (!providerUrl) missing.push('SUPABASE_URL');
  // This module deliberately uses the current publishable-key format, never a secret/service-role key.
  if (typeof publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) missing.push('SUPABASE_PUBLISHABLE_KEY');
  if (!key) missing.push('AUTH_SESSION_KEY');
  if (!application) missing.push('APP_URL');
  if (sessionRegistry !== null && (typeof sessionRegistry?.isRevoked !== 'function' || typeof sessionRegistry?.revoke !== 'function')) missing.push('AUTH_SESSION_REGISTRY');
  const configured = missing.length === 0;
  const secure = application?.protocol === 'https:';
  const origin = application?.origin || 'http://localhost';
  const aad = Buffer.from(`${AUTH_COOKIE_NAME}|${origin}|v1`);
  const revoked = new Map();
  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const clearCookie = () => `${AUTH_COOKIE_NAME}=; ${cookieFlags}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  const setupState = () => ({ configured, setupRequired: !configured, missing: [...missing], user: null });
  const setupResult = () => ({ ...setupState(), setCookie: null });
  const client = () => {
    try { return createClientImpl(providerUrl.href.replace(/\/$/, ''), publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce' }, global: { fetch: boundedAuthFetch } }); }
    catch { throw providerFailure(null, 'configuration'); }
  };

  function cookieValue(header) {
    if (typeof header !== 'string' || header.length > 16000) return null;
    const pairs = header.split(';').map(value => value.trim()).filter(value => value.startsWith(`${AUTH_COOKIE_NAME}=`));
    return pairs.length === 1 ? pairs[0].slice(AUTH_COOKIE_NAME.length + 1) : null;
  }

  function unpack(header, { checkLocalRevocation = true } = {}) {
    const raw = cookieValue(header);
    if (!raw || raw.length > 4000 || !configured) return null;
    try {
      const parts = raw.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') return null;
      const bytes = parts.slice(1).map(part => {
        if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Invalid encoding');
        const value = Buffer.from(part, 'base64url');
        if (value.toString('base64url') !== part) throw new Error('Non-canonical encoding');
        return value;
      });
      if (bytes[0].length !== 12 || bytes[2].length !== 16) return null;
      const decipher = createDecipheriv('aes-256-gcm', key, bytes[0]);
      decipher.setAAD(aad); decipher.setAuthTag(bytes[2]);
      const payload = JSON.parse(Buffer.concat([decipher.update(bytes[1]), decipher.final()]).toString('utf8'));
      if (payload.v !== 1 || !UUID.test(payload.sub || '') || !UUID.test(payload.sid || '') || typeof payload.accessToken !== 'string' || typeof payload.refreshToken !== 'string' || !payload.accessToken || !payload.refreshToken) return null;
      if (![payload.accessExpiresAt, payload.issuedAt, payload.expiresAt].every(Number.isFinite) || payload.expiresAt <= now() || payload.issuedAt > now() + 60000 || payload.expiresAt - payload.issuedAt > MAX_SESSION_MS || payload.expiresAt <= payload.issuedAt) return null;
      for (const [id, until] of revoked) if (until <= now()) revoked.delete(id);
      if (checkLocalRevocation && revoked.has(payload.sid)) return null;
      return payload;
    } catch { return null; }
  }

  function sessionPayload(providerSession, userId, previous) {
    if (!providerSession || typeof providerSession.access_token !== 'string' || !providerSession.access_token || typeof providerSession.refresh_token !== 'string' || !providerSession.refresh_token) throw new AuthError(503, 'auth_session_missing', 'Sign-in did not return a usable session. Please try again.');
    const expiry = Number(providerSession.expires_at) * 1000;
    if (!Number.isFinite(expiry) || expiry <= now()) throw new AuthError(401, 'session_expired', 'Your session has ended. Please sign in again.');
    return { v: 1, sid: previous?.sid || randomUUID(), sub: userId, accessToken: providerSession.access_token, refreshToken: providerSession.refresh_token, accessExpiresAt: expiry, issuedAt: previous?.issuedAt || now(), expiresAt: previous?.expiresAt || now() + MAX_SESSION_MS };
  }

  function pack(payload) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const encoded = ['v1', iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
    if (encoded.length > 3800) throw new AuthError(503, 'auth_session_too_large', 'The session could not be stored securely. Please contact the organiser.');
    return `${AUTH_COOKIE_NAME}=${encoded}; ${cookieFlags}; Max-Age=${Math.floor((payload.expiresAt - now()) / 1000)}`;
  }

  async function getUser(auth, accessToken, expectedId) {
    let result;
    try { result = await auth.getUser(accessToken); } catch { throw providerFailure(null, 'current'); }
    if (result.error) throw providerFailure(result.error, 'current');
    return assertIdentity(result.data?.user, expectedId);
  }

  async function signIn(body) {
    if (!configured) return setupResult();
    const input = credentials(body, false), instance = client();
    let result;
    try { result = await instance.auth.signInWithPassword({ email: input.email, password: input.password }); } catch { throw providerFailure(null, 'signin'); }
    if (result.error) throw providerFailure(result.error, 'signin');
    const session = result.data?.session;
    if (!session?.access_token) throw new AuthError(401, 'session_missing', 'Sign-in could not be completed. Confirm your email and try again.');
    const verified = await getUser(instance.auth, session.access_token);
    const user = safeUser(verified, now()), payload = sessionPayload(session, user.id);
    return { configured: true, user, setCookie: pack(payload), needsEmailConfirmation: false };
  }

  async function signUp(body) {
    if (!configured) return setupResult();
    const input = credentials(body, true), instance = client();
    const options = { emailRedirectTo: `${origin}/?auth=confirmed`, ...(input.name ? { data: { full_name: input.name } } : {}) };
    let result;
    try { result = await instance.auth.signUp({ email: input.email, password: input.password, options }); } catch { throw providerFailure(null, 'signup'); }
    if (result.error) throw providerFailure(result.error, 'signup');
    // With email confirmation enabled the provider returns no session. Do not grant access.
    // PKCE keeps access tokens out of redirect URL fragments; after confirmation, sign in with password.
    if (!result.data?.session) return { configured: true, user: null, setCookie: null, needsEmailConfirmation: true };
    const session = result.data.session, verified = await getUser(instance.auth, session.access_token);
    const user = safeUser(verified, now());
    return { configured: true, user, setCookie: pack(sessionPayload(session, user.id)), needsEmailConfirmation: false };
  }

  async function resolve(header) {
    const saved = unpack(header);
    if (!saved) return null;
    if (sessionRegistry) {
      let denied;
      try { denied = await sessionRegistry.isRevoked({ sid: saved.sid, userId: saved.sub }); }
      catch { throw new AuthError(503, 'auth_sessions_unavailable', 'Account session verification is temporarily unavailable. Please try again.'); }
      if (typeof denied !== 'boolean') throw new AuthError(503, 'auth_sessions_unavailable', 'Account session verification could not be confirmed. Please try again.');
      if (denied) return null;
    }
    const instance = client(); let active = saved, setCookie = null;
    if (saved.accessExpiresAt <= now() + 60000) {
      let refreshed;
      try { refreshed = await instance.auth.refreshSession({ refresh_token: saved.refreshToken }); } catch { throw providerFailure(null, 'refresh'); }
      if (refreshed.error) throw providerFailure(refreshed.error, 'refresh');
      active = sessionPayload(refreshed.data?.session, saved.sub, saved);
      setCookie = pack(active);
    }
    const verified = await getUser(instance.auth, active.accessToken, saved.sub);
    return { user: safeUser(verified, now()), saved: active, setCookie };
  }

  async function currentUser(header, { required = false } = {}) {
    if (!configured) {
      if (required) throw new AuthError(503, 'auth_setup_required', 'Live sign-in needs configuration before this action can run.');
      return setupResult();
    }
    try {
      const verified = await resolve(header);
      if (!verified) {
        if (required) throw new AuthError(401, 'signin_required', 'Sign in to use your live workspace.', clearCookie());
        return { configured: true, user: null, setCookie: cookieValue(header) ? clearCookie() : null };
      }
      return { configured: true, user: verified.user, setCookie: verified.setCookie };
    } catch (error) {
      if (!(error instanceof AuthError)) throw new AuthError(503, 'auth_unavailable', 'Sign-in is temporarily unavailable. Please try again.');
      if (error.status === 401 || error.status === 403) {
        if (required) { error.setCookie = clearCookie(); throw error; }
        return { configured: true, user: null, setCookie: clearCookie(), reason: error.code };
      }
      throw error;
    }
  }

  async function signOut(header) {
    // Sign-out may retry a failed durable revocation even when this app instance already denied the SID.
    const saved = unpack(header, { checkLocalRevocation: false }), setCookie = clearCookie();
    if (!configured || !saved) return { configured, user: null, setCookie, signedOut: true };
    // Supabase signOut revokes refresh tokens; existing access JWTs can remain valid until expiry.
    // A configured durable registry therefore denies this application SID before provider logout,
    // including after process restart. Optional registry-free use only has in-process replay denial.
    revoked.set(saved.sid, saved.expiresAt);
    if (sessionRegistry) {
      try {
        const savedRevocation = await sessionRegistry.revoke({ sid: saved.sid, userId: saved.sub, expiresAt: saved.expiresAt });
        if (savedRevocation !== true) throw new Error('Revocation not confirmed');
      } catch {
        throw new AuthError(503, 'signout_revocation_unavailable', 'You are signed out here, but durable session revocation could not be confirmed. Please try again when the service is available.', setCookie);
      }
    }
    const instance = client();
    try {
      const restored = await instance.auth.setSession({ access_token: saved.accessToken, refresh_token: saved.refreshToken });
      if (restored.error) throw providerFailure(restored.error, 'logout');
      const token = restored.data?.session?.access_token;
      if (!token) throw new AuthError(401, 'session_invalid', 'Your session has ended.');
      await getUser(instance.auth, token, saved.sub);
      const result = await instance.auth.signOut({ scope: 'local' });
      if (result.error) throw providerFailure(result.error, 'logout');
      return { configured: true, user: null, setCookie, signedOut: true };
    } catch (error) {
      if (error instanceof AuthError && error.status === 401) return { configured: true, user: null, setCookie, signedOut: true, providerRevocationConfirmed: false };
      throw new AuthError(503, 'signout_incomplete', 'You are signed out here, but server session revocation could not be confirmed. Please try again when the service is available.', setCookie);
    }
  }

  return Object.freeze({ configured, setupState, cookieName: AUTH_COOKIE_NAME, clearCookie, signIn, signUp, currentUser, requireUser: header => currentUser(header, { required: true }), signOut });
}
