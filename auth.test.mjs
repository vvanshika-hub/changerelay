import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthService, AuthError } from './auth.mjs';

const USER_ID = 'f43dd378-8d47-42f0-95a5-35b926cf22cb';
const OTHER_ID = '01dc0d26-9a56-482f-897e-ceca062bf635';
const USER = { id: USER_ID, email: 'organiser@example.com', email_confirmed_at: '2026-10-01T00:00:00Z', is_anonymous: false, user_metadata: { full_name: 'Organiser', role: 'admin', sub: OTHER_ID } };
const credentials = { email: ' Organiser@example.com ', password: 'correct-secret-for-tests' };
const cookie = result => result.setCookie.split(';')[0];

function fixture(overrides = {}) {
  let clock = Date.UTC(2026, 9, 30, 10);
  const state = { user: structuredClone(USER), getUserCalls: [], refreshCalls: [], signOutCalls: [], clientOptions: [], signinCalls: [], signupCalls: [], signinError: null, getUserError: null, refreshError: null, logoutError: null, noSignupSession: false, refreshedUser: null, ...overrides };
  const session = suffix => ({ access_token: `private-access-token-${suffix}`, refresh_token: `private-refresh-token-${suffix}`, expires_at: Math.floor(clock / 1000) + 3600, user: { ...USER, id: OTHER_ID } });
  const createClientImpl = (url, key, options) => {
    state.clientOptions.push({ url, key, options });
    let restored;
    return { auth: {
      signInWithPassword: async input => { state.signinCalls.push(input); return { data: { session: session('initial'), user: { ...USER, id: OTHER_ID } }, error: state.signinError }; },
      signUp: async input => { state.signupCalls.push(input); return { data: { session: state.noSignupSession ? null : session('initial'), user: USER }, error: null }; },
      getUser: async token => { state.getUserCalls.push(token); return { data: { user: token.includes('refreshed') && state.refreshedUser ? state.refreshedUser : state.user }, error: state.getUserError }; },
      refreshSession: async input => { state.refreshCalls.push(input); return { data: { session: session('refreshed') }, error: state.refreshError }; },
      setSession: async input => { restored = input; return { data: { session: { ...session('restored'), access_token: input.access_token } }, error: null }; },
      signOut: async input => { state.signOutCalls.push({ input, restored: !!restored }); return { error: state.logoutError }; },
      getSession: () => { throw new Error('getSession must never establish identity'); },
    } };
  };
  const config = { url: 'https://project.supabase.co', publishableKey: 'sb_publishable_fixture', sessionKey: Buffer.alloc(32, 7), appUrl: 'https://changerelay.example', createClientImpl, now: () => clock };
  const service = createAuthService(config);
  return { service, state, config, advance: ms => { clock += ms; } };
}

test('missing configuration produces a real setup state without provider calls', async () => {
  let calls = 0;
  const service = createAuthService({ createClientImpl: () => { calls++; throw new Error('unexpected'); } });
  assert.equal(service.configured, false);
  assert.deepEqual(service.setupState().missing, ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'AUTH_SESSION_KEY', 'APP_URL']);
  assert.equal((await service.signIn(credentials)).setupRequired, true);
  assert.equal((await service.currentUser('')).user, null);
  await assert.rejects(service.requireUser(''), error => error.status === 503);
  assert.equal(calls, 0);
});

test('sign-in trusts getUser identity and returns only a safe user and encrypted cookie', async () => {
  const { service, state } = fixture();
  const result = await service.signIn(credentials);
  assert.deepEqual(result.user, { id: USER_ID, email: USER.email, name: 'Organiser' });
  assert.equal(state.signinCalls[0].email, 'organiser@example.com');
  assert.equal(state.signinCalls[0].password, credentials.password);
  assert.equal(state.getUserCalls.length, 1);
  assert.match(result.setCookie, /HttpOnly/);
  assert.match(result.setCookie, /SameSite=Lax/);
  assert.match(result.setCookie, /Secure/);
  const serialised = JSON.stringify(result);
  assert(!serialised.includes('private-access-token'));
  assert(!serialised.includes('private-refresh-token'));
  assert(!serialised.includes(credentials.password));
  assert(!Object.hasOwn(result.user, 'role'));
  const current = await service.currentUser(cookie(result));
  assert.equal(current.user.id, USER_ID);
  assert.equal(state.clientOptions.length, 2);
  assert.deepEqual(state.clientOptions[0].options.auth, { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce' });
});

test('encrypted cookies use a random IV for every sign-in', async () => {
  const { service } = fixture();
  const first = await service.signIn(credentials), second = await service.signIn(credentials);
  assert.notEqual(cookie(first), cookie(second));
});

test('cookie tampering and duplicate cookie names are rejected before contacting provider', async () => {
  const { service, state } = fixture();
  const signed = cookie(await service.signIn(credentials));
  const last = signed.at(-1), tampered = signed.slice(0, -1) + (last === 'A' ? 'B' : 'A');
  const calls = state.getUserCalls.length;
  assert.equal((await service.currentUser(tampered)).user, null);
  assert.equal((await service.currentUser(`${signed}; ${signed}`)).user, null);
  assert.equal(state.getUserCalls.length, calls);
  await assert.rejects(service.requireUser(tampered), error => error.status === 401 && !!error.setCookie);
});

test('cookie expiry is enforced independently of access-token refresh', async () => {
  const { service, state, advance } = fixture();
  const signed = cookie(await service.signIn(credentials));
  advance(8 * 86400000);
  const result = await service.currentUser(signed);
  assert.equal(result.user, null);
  assert.match(result.setCookie, /Max-Age=0/);
  assert.equal(state.refreshCalls.length, 0);
});

test('near-expired access is refreshed and the refreshed token is verified with getUser', async () => {
  const { service, state, advance } = fixture();
  const signed = cookie(await service.signIn(credentials));
  advance(3550000);
  const result = await service.requireUser(signed);
  assert.equal(result.user.id, USER_ID);
  assert.equal(state.refreshCalls.length, 1);
  assert.equal(state.getUserCalls.at(-1), 'private-access-token-refreshed');
  assert(result.setCookie);
  assert(!JSON.stringify(result).includes('private-refresh-token'));
});

test('refresh cannot switch the cookie owner even when provider session metadata claims otherwise', async () => {
  const { service, state, advance } = fixture();
  const signed = cookie(await service.signIn(credentials));
  state.refreshedUser = { ...USER, id: OTHER_ID };
  advance(3600000);
  await assert.rejects(service.requireUser(signed), error => error.status === 401 && error.code === 'session_invalid');
});

test('a cookie cannot be reused with a different app origin or key', async () => {
  const { service, config } = fixture();
  const signed = cookie(await service.signIn(credentials));
  const differentOrigin = createAuthService({ ...config, appUrl: 'https://other.example' });
  const differentKey = createAuthService({ ...config, sessionKey: Buffer.alloc(32, 8) });
  assert.equal((await differentOrigin.currentUser(signed)).user, null);
  assert.equal((await differentKey.currentUser(signed)).user, null);
});

test('anonymous and unconfirmed users cannot establish a live session', async () => {
  const anonymous = fixture({ user: { ...USER, is_anonymous: true } });
  await assert.rejects(anonymous.service.signIn(credentials), error => error.status === 403 && error.code === 'account_required');
  const unconfirmed = fixture({ user: { ...USER, email_confirmed_at: null } });
  await assert.rejects(unconfirmed.service.signIn(credentials), error => error.status === 403 && error.code === 'email_confirmation_required');
});

test('signup requiring email confirmation returns no user or session cookie', async () => {
  const { service, state } = fixture({ noSignupSession: true });
  const result = await service.signUp({ ...credentials, name: 'Event organiser' });
  assert.deepEqual(result, { configured: true, user: null, setCookie: null, needsEmailConfirmation: true });
  assert.equal(state.getUserCalls.length, 0);
  assert.equal(state.signupCalls[0].options.emailRedirectTo, 'https://changerelay.example/?auth=confirmed');
  assert.equal(state.signupCalls[0].options.data.full_name, 'Event organiser');
});

test('validation rejects malformed credentials before any provider action', async () => {
  const { service, state } = fixture();
  await assert.rejects(service.signIn({ email: 'broken', password: 'x' }), error => error.status === 400);
  await assert.rejects(service.signUp({ email: USER.email, password: 'short' }), error => error.status === 400);
  await assert.rejects(service.signIn({ email: USER.email, password: {} }), error => error.status === 400);
  assert.equal(state.signinCalls.length, 0); assert.equal(state.signupCalls.length, 0);
});

test('provider errors are sanitised and never expose credentials or provider bodies', async () => {
  const { service } = fixture({ signinError: { status: 400, message: 'private-access-token-in-provider-message', body: credentials } });
  await assert.rejects(service.signIn(credentials), error => error instanceof AuthError && error.status === 401 && !JSON.stringify(error).includes('private-access-token') && !error.message.includes('private-access-token'));
});

test('provider outages preserve the existing cookie and fail closed', async () => {
  const { service, state } = fixture();
  const signed = cookie(await service.signIn(credentials));
  state.getUserError = { status: 500, message: 'internal-provider-secret' };
  await assert.rejects(service.requireUser(signed), error => error.status === 503 && !error.setCookie && !error.message.includes('secret'));
});

test('signout restores the private server session, revokes only it and clears the cookie', async () => {
  const { service, state } = fixture();
  const signed = cookie(await service.signIn(credentials));
  const result = await service.signOut(signed);
  assert.equal(result.signedOut, true); assert.match(result.setCookie, /Max-Age=0/);
  assert.deepEqual(state.signOutCalls, [{ input: { scope: 'local' }, restored: true }]);
  assert.equal((await service.currentUser(signed)).user, null);
});

test('signout clears local access even when provider revocation fails', async () => {
  const { service, state } = fixture();
  const signed = cookie(await service.signIn(credentials));
  state.logoutError = { status: 500, message: 'private-provider-error' };
  await assert.rejects(service.signOut(signed), error => error.status === 503 && /Max-Age=0/.test(error.setCookie));
  assert.equal((await service.currentUser(signed)).user, null);
});

test('non-local HTTP and weak session keys remain setup-required; localhost may use HTTP', async () => {
  const { config } = fixture();
  assert.equal(createAuthService({ ...config, appUrl: 'http://production.example' }).configured, false);
  assert.equal(createAuthService({ ...config, sessionKey: 'weak-passphrase' }).configured, false);
  assert.equal(createAuthService({ ...config, publishableKey: 'sb_secret_must_never_be_used' }).configured, false);
  const service = createAuthService({ ...config, appUrl: 'http://localhost:3000' });
  assert.equal(service.configured, true);
  assert(!(await service.signIn(credentials)).setCookie.includes('; Secure'));
});

test('provider client construction failures are sanitised', async () => {
  const { config } = fixture();
  const service = createAuthService({ ...config, createClientImpl: () => { throw new Error('private-configuration-key'); } });
  await assert.rejects(service.signIn(credentials), error => error.status === 503 && !error.message.includes('private'));
});

test('durable registry read failures fail closed before provider identity is returned', async () => {
  const { service, state, config } = fixture();
  const signed = cookie(await service.signIn(credentials)), calls = state.getUserCalls.length;
  const protectedService = createAuthService({ ...config, sessionRegistry: { isRevoked: async () => { throw new Error('private-store-secret'); }, revoke: async () => true } });
  await assert.rejects(protectedService.requireUser(signed), error => error.status === 503 && error.code === 'auth_sessions_unavailable' && !error.message.includes('secret'));
  assert.equal(state.getUserCalls.length, calls);
});

test('durable registry write failures are explicit, clear the browser and never call provider logout first', async () => {
  const { service, state, config } = fixture();
  const signed = cookie(await service.signIn(credentials));
  const protectedService = createAuthService({ ...config, sessionRegistry: { isRevoked: async () => false, revoke: async () => { throw new Error('private-store-error'); } } });
  await assert.rejects(protectedService.signOut(signed), error => error.status === 503 && error.code === 'signout_revocation_unavailable' && /Max-Age=0/.test(error.setCookie));
  assert.equal(state.signOutCalls.length, 0);
});

test('a non-boolean durable session answer never authenticates a user', async () => {
  const { service, config } = fixture();
  const signed = cookie(await service.signIn(credentials));
  const protectedService = createAuthService({ ...config, sessionRegistry: { isRevoked: async () => null, revoke: async () => true } });
  await assert.rejects(protectedService.requireUser(signed), error => error.status === 503);
});
