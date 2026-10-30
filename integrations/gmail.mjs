import { createHash } from 'node:crypto';

/** Server-only Gmail actions; every send uses a persisted approval and an atomic outcome claim. */
const ACTIONS = Object.freeze({ send: ['rowogelpy0h6', 'V55'], search: ['rowr1h03w5cx', 'V22'], read: ['row8s689orsm', 'V3'] });

export class GmailSetupError extends Error {
  constructor(message = 'Connect your Gmail account before continuing.') { super(message); this.name = 'GmailSetupError'; this.code = 'GMAIL_SETUP_REQUIRED'; }
}
export class GmailApprovalError extends Error {
  constructor(message = 'Review and approve this exact announcement before sending it.') { super(message); this.name = 'GmailApprovalError'; this.code = 'GMAIL_APPROVAL_REQUIRED'; }
}
export class GmailInputError extends Error {
  constructor(message) { super(message); this.name = 'GmailInputError'; this.code = 'INVALID_GMAIL_INPUT'; }
}
export class GmailStoreError extends Error {
  constructor() { super('The announcement outcome store is unavailable. Check any existing send receipt before trying again.'); this.name = 'GmailStoreError'; this.code = 'GMAIL_OUTCOME_STORE_UNAVAILABLE'; }
}

function text(value, label, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new GmailInputError(`Enter a valid ${label}.`);
  return value;
}
function mailbox(value, label) {
  text(value, label, 320);
  // One bare address only. Display names, lists, headers and CC/BCC are never accepted as recipients.
  if (!/^[^\s@,;<>()[\]:"\\]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(value) || /[\r\n\x00-\x1f]/.test(value)) {
    throw new GmailInputError(`${label} must be one email address, without a recipient list or display name.`);
  }
  const domain = value.split('@')[1].toLowerCase();
  if (['example.com', 'example.org', 'example.net'].includes(domain) || /(?:^|\.)(?:example|invalid|test|localhost|local|sample)$/.test(domain)) {
    throw new GmailInputError('Sample email addresses cannot be used for a live announcement.');
  }
  return value;
}
function cleanSubject(value) {
  text(value, 'approved subject', 998);
  if (/[\r\n\x00-\x1f\x7f]/.test(value)) throw new GmailInputError('The subject cannot contain line breaks or header characters.');
  return value;
}
function plainBody(value) {
  text(value, 'approved plain-text message');
  // Do not escape or rewrite after approval: the draft must be plain text when it is approved.
  if (/<\/?[a-z][^>]*>/i.test(value) || /\x00/.test(value)) throw new GmailInputError('Review a plain-text announcement before sending. HTML messages are not supported by this workflow.');
  return value;
}
const digest = value => createHash('sha256').update(value).digest('hex');
const normalBody = value => value.replace(/\r\n/g, '\n').replace(/\n$/, '');
const bodyHash = value => digest(normalBody(value));

/** Hash only the exact approved send payload, in a fixed key order; useful for importing a known receipt. */
export function gmailApprovedPayloadHash({ recipient, from, subject, messageBody, receiptMarker }) {
  return digest(JSON.stringify({ recipient, from, subject, messageBody, receiptMarker }));
}

function approvalReference(input) {
  const id = text(input?.approvalId, 'saved approval', 256);
  const { version, hash } = input;
  if (!Number.isInteger(version) || version < 1 || typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) throw new GmailApprovalError();
  return { id, version, hash };
}
function approvedPayload(record, reference, userId) {
  if (!record || record.id !== reference.id || record.version !== reference.version || record.hash !== reference.hash || record.userId !== userId ||
      typeof record.approvedAt !== 'string' || !Number.isFinite(Date.parse(record.approvedAt))) throw new GmailApprovalError();
  const recipient = mailbox(record.recipient, 'Approved recipient');
  const from = mailbox(record.from, 'Approved sender');
  const subject = cleanSubject(record.subject);
  const messageBody = plainBody(record.messageBody);
  const receiptMarker = text(record.receiptMarker, 'approved receipt marker', 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{6,99}$/.test(receiptMarker) || !subject.includes(receiptMarker)) {
    throw new GmailApprovalError('The approved subject must contain its unique change receipt marker. Review the draft again.');
  }
  // Copy all primitives before any asynchronous action; a later mutation of the caller's object cannot change a send.
  const payload = { recipient, from, subject, messageBody, receiptMarker };
  return { ...payload, reference: { ...reference }, payloadHash: gmailApprovedPayloadHash(payload), bodyHash: bodyHash(messageBody) };
}

function publicOutcome(outcome, fallbackReason) {
  const sent = outcome.status === 'sent';
  return {
    status: sent ? 'sent' : 'needs-checking', sent, acknowledged: false, receiptId: outcome.receiptId,
    ...(outcome.providerMessageId ? { providerMessageId: outcome.providerMessageId } : {}),
    ...(outcome.providerThreadId ? { providerThreadId: outcome.providerThreadId } : {}),
    ...(sent ? { verified: true } : { reason: fallbackReason || outcome.reason || 'This announcement may have been sent. Check its receipt before sending another message.' }),
  };
}

function headerAddresses(value) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string') return null;
  // Gmail's tested read action returns header strings. Read parsing does not create a send payload.
  const header = value.trim();
  const bare = /^[^\s@,;<>()[\]:"\\]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i;
  if (bare.test(header) && !/[\r\n\x00-\x1f]/.test(header)) return [header.toLowerCase()];
  const wrapped = /^(?:"(?:[^"\\]|\\.)*"|[^<>"\\\r\n,;]+)\s*<([^<>\r\n]+)>$/.exec(header);
  return wrapped && bare.test(wrapped[1]) ? [wrapped[1].toLowerCase()] : null;
}
function messageMatches(message, approved) {
  const to = headerAddresses(message?.to), from = headerAddresses(message?.from);
  const cc = headerAddresses(message?.cc), bcc = headerAddresses(message?.bcc);
  return typeof message?.id === 'string' && message.id && Array.isArray(message.labelIds) && message.labelIds.includes('SENT') &&
    to?.length === 1 && to[0] === approved.recipient.toLowerCase() &&
    from?.length === 1 && from[0] === approved.from.toLowerCase() && cc?.length === 0 && bcc?.length === 0 &&
    message.subject === approved.subject && typeof message.body?.plain === 'string' && bodyHash(message.body.plain) === approved.bodyHash;
}

/**
 * `loadApproval({id,version,hash,userId})` must load and verify the exact immutable approved version
 * from the product database. Browser-provided timestamps or arbitrary message bodies are not approval.
 * `store` is server-injected and durable: get(key), atomic create(key,record)->boolean, update(key,patch).
 * Its update must keep sent terminal, so a delayed reconciliation cannot overwrite a confirmed send.
 */
export function createGmailAdapter({ viasocket, userId, authId, store, loadApproval } = {}) {
  if (!viasocket || typeof viasocket.user !== 'function' || !viasocket.catalog || typeof userId !== 'string' || !userId.trim() ||
      typeof authId !== 'string' || !authId.trim()) throw new GmailSetupError();
  if (!store || ['get', 'create', 'update'].some(method => typeof store[method] !== 'function')) throw new GmailStoreError();
  if (typeof loadApproval !== 'function') throw new GmailApprovalError('A server-owned approved-version loader is required before sending.');
  const user = viasocket.user(userId);
  let servicePromise;
  async function resolveService() {
    // The exact-name catalog search is the tested fallback for Gmail's currently broken slug resolver.
    const matches = (await viasocket.catalog.search('Gmail')).filter(app => app.name === 'Gmail');
    if (matches.length !== 1 || !matches[0].serviceId) throw new GmailSetupError('Gmail could not be uniquely identified in the current integration catalog.');
    return matches[0].serviceId;
  }
  const serviceId = () => servicePromise ??= resolveService().catch(error => { servicePromise = undefined; throw error; });
  const version = async action => viasocket.catalog.versionIdFor(await serviceId(), ...ACTIONS[action]);
  const storeKey = receiptId => `${userId}:${receiptId}`;

  async function ownedConnection() {
    const service = await serviceId();
    const connections = await user.listConnections();
    const connection = Array.isArray(connections) && connections.find(item => item && item.id === authId && item.service_id === service);
    if (!connection) throw new GmailSetupError('Reconnect the Gmail account linked to this workspace.');
    if (connection.isExpired === true) throw new GmailSetupError('Your Gmail connection expired. Reconnect it before continuing.');
    return connection;
  }
  async function executionId() {
    await ownedConnection();
    const service = await serviceId();
    const existing = await user.findEnabled(service);
    if (existing) {
      const flows = await user.listFlows();
      const flow = flows.find(item => item.id === existing && item.serviceId === service && item.authId === authId && item.status !== 'deleted');
      if (!flow) throw new GmailSetupError('The enabled Gmail account differs from the saved sender connection. Reconnect the selected account.');
      if (flow.status === 'paused') throw new GmailSetupError('This Gmail connection is paused. Resume it in connection settings before continuing.');
      return existing;
    }
    const enabled = await user.enable(service, authId);
    if (!enabled?.scriptId || enabled.authId !== authId || enabled.serviceId !== service) throw new GmailSetupError('Gmail could not be enabled for this workspace.');
    return enabled.scriptId;
  }
  async function run(action, inputData) { return viasocket.runAction(await executionId(), await version(action), inputData); }
  async function canonicalApproval(reference) {
    const record = await loadApproval({ ...reference, userId });
    return approvedPayload(record, reference, userId);
  }
  async function outcomeGet(key) {
    try { return await store.get(key); } catch { throw new GmailStoreError(); }
  }
  async function savePatch(key, patch) {
    try { await store.update(key, patch); } catch { throw new GmailStoreError(); }
  }
  function ownedOutcome(outcome, receiptId, approved) {
    if (!outcome || outcome.ownerId !== userId || outcome.receiptId !== receiptId || (approved && outcome.payloadHash !== approved.payloadHash)) {
      throw new GmailApprovalError('This receipt does not match the approved message in this workspace.');
    }
    return outcome;
  }
  async function senderOptions() {
    await ownedConnection();
    return user.listOptions(await version('send'), { authId, fieldKey: 'from', existingFields: {} });
  }
  async function readMessage({ messageId }) {
    text(messageId, 'message receipt', 512);
    const message = await run('read', { message_id: messageId });
    if (!message || message.id !== messageId) throw new GmailInputError('Gmail did not return the requested message receipt.');
    return message;
  }
  async function searchFor(approved) {
    const result = await run('search', {
      search_mode: 'manual', includeReplies: false, query: ['subject', 'to'],
      searchFields: { subject: approved.receiptMarker, to: approved.recipient, operator: 'AND' },
      pagination: { maxResults: 5 }, select_response_fields: ['id', 'subject', 'to', 'from', 'labelIds', 'originalSentDate'],
    });
    if (!result || !Array.isArray(result.emails)) throw new GmailInputError('Gmail did not return a readable receipt search.');
    return result;
  }
  async function markUncertain(key, outcome, reason, provider = {}) {
    let current;
    try { current = ownedOutcome(await outcomeGet(key), outcome.receiptId); }
    catch { return publicOutcome({ ...outcome, ...provider, status: 'needs-checking' }, 'The result could not be saved. This message may have been sent; check its receipt before trying again.'); }
    if (current.status === 'sent') return publicOutcome(current);
    const patch = { status: 'needs-checking', acknowledged: false, reason, checkedAt: new Date().toISOString(), ...provider };
    try { await savePatch(key, patch); }
    catch { return publicOutcome({ ...outcome, ...patch }, 'The result could not be saved. This message may have been sent; do not resend it.'); }
    return publicOutcome({ ...outcome, ...patch });
  }
  async function markSent(key, outcome, message) {
    const patch = { status: 'sent', acknowledged: false, providerMessageId: message.id, ...(message.threadId ? { providerThreadId: message.threadId } : {}), verifiedAt: new Date().toISOString(), reason: null };
    try { await savePatch(key, patch); }
    catch { return publicOutcome({ ...outcome, ...patch, status: 'needs-checking' }, 'Gmail accepted this message, but its receipt could not be saved. Check the existing message before retrying.'); }
    return publicOutcome({ ...outcome, ...patch });
  }

  return Object.freeze({
    async connection() { await ownedConnection(); return { connected: true, app: 'Gmail', expired: false }; },
    senderOptions,
    readMessage,
    async searchReceipt(input) { return searchFor(await canonicalApproval(approvalReference(input))); },
    async sendApproved(input) {
      if (input?.scheduleVerified !== true) throw new GmailApprovalError('Verify both Calendar and Sheets before sending the approved announcement.');
      const reference = approvalReference(input);
      const approved = await canonicalApproval(reference);
      const key = storeKey(approved.receiptMarker);
      let existing = await outcomeGet(key);
      if (existing) return publicOutcome(ownedOutcome(existing, approved.receiptMarker, approved));
      const available = await senderOptions();
      if (!Array.isArray(available.options) || !available.options.some(option => typeof option.value === 'string' && option.value.toLowerCase() === approved.from.toLowerCase())) {
        throw new GmailApprovalError('The approved sender is not available on the connected Gmail account. Review the sender selection.');
      }
      // Finish account/flow validation before claiming Sending, so a known disconnected account does
      // not create an uncertain-send record when no consequential call could have been attempted.
      const sendExecution = { script: await executionId(), version: await version('send') };
      const outcome = {
        ownerId: userId, receiptId: approved.receiptMarker, approvalId: reference.id, approvalVersion: reference.version,
        approvalHash: reference.hash, payloadHash: approved.payloadHash, status: 'sending', acknowledged: false,
        createdAt: new Date().toISOString(),
      };
      let claimed;
      try { claimed = await store.create(key, outcome); } catch { throw new GmailStoreError(); }
      if (claimed !== true) {
        existing = await outcomeGet(key);
        return publicOutcome(ownedOutcome(existing, approved.receiptMarker, approved));
      }
      // The atomic durable Sending record exists before the first potentially consequential call.
      let provider;
      try { provider = await viasocket.runAction(sendExecution.script, sendExecution.version, { to: approved.recipient, from: approved.from, subject: approved.subject, messageBody: approved.messageBody }); }
      catch {
        return markUncertain(key, outcome, 'Gmail did not confirm the send result. Check this receipt before sending another message.');
      }
      if (!provider || typeof provider.id !== 'string' || !provider.id) {
        return markUncertain(key, outcome, 'Gmail returned no message receipt. The message may have been accepted; check before resending.');
      }
      const providerIds = { providerMessageId: provider.id, ...(typeof provider.threadId === 'string' ? { providerThreadId: provider.threadId } : {}) };
      try { await savePatch(key, providerIds); }
      catch { return publicOutcome({ ...outcome, ...providerIds, status: 'needs-checking' }, 'Gmail accepted this message, but its receipt could not be saved. Do not resend it.'); }
      let message;
      try { message = await readMessage({ messageId: provider.id }); }
      catch { return markUncertain(key, outcome, 'Gmail accepted this message, but it could not be read back yet. Check the existing receipt before retrying.', providerIds); }
      if (!messageMatches(message, approved)) return markUncertain(key, outcome, 'The accepted message did not match every approved receipt detail. Check it before taking further action.', providerIds);
      return markSent(key, outcome, message);
    },
    async reconcile({ receiptId }) {
      text(receiptId, 'change receipt', 100);
      const key = storeKey(receiptId);
      const outcome = ownedOutcome(await outcomeGet(key), receiptId);
      if (outcome.status === 'sent') return publicOutcome(outcome);
      const approved = await canonicalApproval({ id: outcome.approvalId, version: outcome.approvalVersion, hash: outcome.approvalHash });
      ownedOutcome(outcome, receiptId, approved);
      if (outcome.providerMessageId) {
        try {
          const message = await readMessage({ messageId: outcome.providerMessageId });
          if (messageMatches(message, approved)) return markSent(key, outcome, message);
        } catch { /* A failed read is not proof that a send failed. Search by its approved marker next. */ }
      }
      let search;
      try { search = await searchFor(approved); }
      catch { return markUncertain(key, outcome, 'Gmail receipt search is unavailable. Do not resend until the existing result can be checked.'); }
      if (search.nextPageToken || search.totalResults > 5) return markUncertain(key, outcome, 'More messages matched this receipt than can be checked safely. Review the sent mail before sending again.');
      const ids = [...new Set(search.emails.map(message => message?.id).filter(id => typeof id === 'string' && id))];
      const matches = [];
      let incomplete = false;
      for (const messageId of ids) {
        try { const message = await readMessage({ messageId }); if (messageMatches(message, approved)) matches.push(message); }
        catch { incomplete = true; }
      }
      if (matches.length === 1 && !incomplete) return markSent(key, outcome, matches[0]);
      return markUncertain(key, outcome, matches.length > 1 ? 'Multiple sent messages match this receipt. Review them before any further send.' : 'No single verified sent message was found yet. This does not prove the send failed; do not resend blindly.');
    },
  });
}
