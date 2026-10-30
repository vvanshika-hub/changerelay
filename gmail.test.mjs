import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGmailAdapter, gmailApprovedPayloadHash, GmailApprovalError, GmailInputError, GmailSetupError, GmailStoreError } from './integrations/gmail.mjs';

const approved = (overrides = {}) => ({
  id: 'saved-plan', version: 1, hash: 'a'.repeat(64), userId: 'signed-in-organiser', approvedAt: '2026-10-30T10:00:00Z',
  recipient: 'attendee@organiser.dev', from: 'organiser@organiser.dev', subject: 'Workshop moved — CR-unique-receipt-123456',
  messageBody: 'The workshop now starts at 4 pm IST. See you there.', receiptMarker: 'CR-unique-receipt-123456', ...overrides,
});
const reference = () => ({ approvalId: 'saved-plan', version: 1, hash: 'a'.repeat(64), scheduleVerified: true });

function memoryStore() {
  const records = new Map();
  return {
    records,
    get: async key => records.has(key) ? structuredClone(records.get(key)) : null,
    create: async (key, value) => { if (records.has(key)) return false; records.set(key, structuredClone(value)); return true; },
    update: async (key, patch) => { const current = records.get(key); if (!current) throw Error('Missing receipt'); if (current.status === 'sent' && patch.status && patch.status !== 'sent') return; records.set(key, { ...current, ...structuredClone(patch) }); },
  };
}

function fakeSDK({ approval = approved(), sendError = false, missingId = false, readError = false, mismatch = false, readOverrides = {}, searchCount = 1, wrongOwner = false, expired = false, flowMismatch = false, store = memoryStore(), loader } = {}) {
  let sends = 0;
  const calls = [];
  const message = id => ({ id, threadId: 'provider-thread', labelIds: ['SENT'], to: approval.recipient, from: 'Organiser <' + approval.from + '>', cc: '', bcc: '', subject: mismatch ? 'Unexpected subject' : approval.subject, body: { plain: approval.messageBody, html: '' }, ...readOverrides });
  const user = {
    listConnections: async () => wrongOwner ? [] : [{ id: 'owned-auth', service_id: 'live-gmail-service', isExpired: expired }],
    findEnabled: async () => 'owned-script',
    listFlows: async () => [{ id: 'owned-script', authId: flowMismatch ? 'different-account' : 'owned-auth', serviceId: 'live-gmail-service', status: 'active' }],
    enable: async () => { throw Error('Should not duplicate a flow'); },
    listOptions: async (action, params) => { calls.push({ action, params }); return { options: [{ label: approval.from, value: approval.from }] }; },
  };
  const sdk = {
    user: id => { assert.equal(id, 'signed-in-organiser'); return user; },
    catalog: { search: async query => { assert.equal(query, 'Gmail'); return [{ name: 'Gmail', serviceId: 'live-gmail-service' }, { name: 'Other email', serviceId: 'other-service' }]; }, versionIdFor: async (_service, action) => action },
    runAction: async (_script, action, input) => {
      calls.push({ action, input });
      if (action === 'rowogelpy0h6') {
        assert.equal([...store.records.values()][0]?.status, 'sending', 'Durable Sending must be saved before Gmail is called');
        sends++; if (sendError) throw Error('Timeout with unknown result');
        return missingId ? { accepted: true } : { id: 'provider-message', threadId: 'provider-thread', labelIds: ['SENT'] };
      }
      if (action === 'row8s689orsm') { if (readError) throw Error('Read temporarily unavailable'); return message(input.message_id); }
      if (action === 'rowr1h03w5cx') return { totalResults: searchCount, emails: Array.from({ length: searchCount }, (_, index) => ({ id: 'provider-message-' + index })), nextPageToken: null };
      throw Error('Unexpected action');
    },
  };
  const adapter = createGmailAdapter({ viasocket: sdk, userId: 'signed-in-organiser', authId: 'owned-auth', store, loadApproval: loader ?? (async ref => ref.id === approval.id && ref.version === approval.version && ref.hash === approval.hash ? structuredClone(approval) : null) });
  return { adapter, store, calls, sends: () => sends, sdk, approval };
}

test('Sends the exact server-approved payload to one recipient, persists first, and separates sent from acknowledged', async () => {
  const fake = fakeSDK();
  const result = await fake.adapter.sendApproved(reference());
  assert.equal(result.status, 'sent');
  assert.equal(result.acknowledged, false);
  assert.equal(result.providerMessageId, 'provider-message');
  const send = fake.calls.find(call => call.action === 'rowogelpy0h6' && call.input);
  assert.deepEqual(send.input, { to: fake.approval.recipient, from: fake.approval.from, subject: fake.approval.subject, messageBody: fake.approval.messageBody });
  assert.equal('cc' in send.input, false); assert.equal('bcc' in send.input, false);
  assert.equal('authId' in result, false); assert.equal('scriptId' in result, false);
});

test('Repeated and concurrent approvals claim one durable outcome and send once', async () => {
  const fake = fakeSDK();
  await Promise.all([fake.adapter.sendApproved(reference()), fake.adapter.sendApproved(reference())]);
  assert.equal(fake.sends(), 1);
  assert.equal((await fake.adapter.sendApproved(reference())).status, 'sent');
  assert.equal(fake.sends(), 1);
});

test('Timeout becomes needs-checking; repeated calls never send blindly; marker reconciliation can verify it', async () => {
  const fake = fakeSDK({ sendError: true });
  assert.equal((await fake.adapter.sendApproved(reference())).status, 'needs-checking');
  assert.equal((await fake.adapter.sendApproved(reference())).status, 'needs-checking');
  assert.equal(fake.sends(), 1);
  const receipt = await fake.adapter.reconcile({ receiptId: fake.approval.receiptMarker });
  assert.equal(receipt.status, 'sent');
  assert.equal(receipt.acknowledged, false);
  assert.equal(fake.sends(), 1);
  const query = fake.calls.find(call => call.action === 'rowr1h03w5cx').input;
  assert.deepEqual(query.searchFields, { subject: fake.approval.receiptMarker, to: fake.approval.recipient, operator: 'AND' });
});

test('No matching receipt, multiple matches or unverifiable readback remain uncertain', async () => {
  for (const options of [{ searchCount: 0 }, { searchCount: 2 }, { readError: true }, { mismatch: true }]) {
    const fake = fakeSDK({ sendError: true, ...options });
    await fake.adapter.sendApproved(reference());
    assert.equal((await fake.adapter.reconcile({ receiptId: fake.approval.receiptMarker })).status, 'needs-checking');
    assert.equal(fake.sends(), 1);
  }
});

test('A provider ID alone does not prove the approved message was verified', async () => {
  const fake = fakeSDK({ mismatch: true });
  assert.equal((await fake.adapter.sendApproved(reference())).status, 'needs-checking');
  assert.equal(fake.sends(), 1);
  const missing = fakeSDK({ missingId: true });
  assert.equal((await missing.adapter.sendApproved(reference())).status, 'needs-checking');
});

test('Recipient lists, sample recipients, header injection and HTML drafts are blocked before send', async () => {
  for (const overrides of [
    { recipient: 'one@organiser.dev,two@organiser.dev' }, { recipient: 'Fictional <one@organiser.dev>' },
    { recipient: 'fake@example.com' }, { recipient: 'fake@fixture.invalid' },
    { subject: 'Approved\r\nBcc: stranger@organiser.dev' }, { messageBody: '<b>Changed schedule</b>' },
  ]) {
    const fake = fakeSDK({ approval: approved(overrides) });
    await assert.rejects(fake.adapter.sendApproved(reference()), GmailInputError);
    assert.equal(fake.sends(), 0);
  }
});

test('A changed or absent approved version, other owner, or missing marker cannot be sent', async () => {
  for (const overrides of [{ userId: 'another-owner' }, { subject: 'Subject without its receipt' }, { approvedAt: null }]) {
    const fake = fakeSDK({ approval: approved(overrides) });
    await assert.rejects(fake.adapter.sendApproved(reference()), GmailApprovalError);
    assert.equal(fake.sends(), 0);
  }
  const fake = fakeSDK();
  await assert.rejects(fake.adapter.sendApproved({ ...reference(), hash: 'b'.repeat(64) }), GmailApprovalError);
  await assert.rejects(fake.adapter.sendApproved({ ...reference(), version: 2 }), GmailApprovalError);
  await assert.rejects(fake.adapter.sendApproved({ ...reference(), scheduleVerified: false }), GmailApprovalError);
  assert.equal(fake.sends(), 0);
});

test('Mutation after approval loading cannot alter the captured send payload', async () => {
  const stored = approved();
  const fake = fakeSDK({ approval: stored, loader: async () => stored });
  const originalBody = stored.messageBody;
  const realOptions = fake.sdk.user('signed-in-organiser').listOptions;
  fake.sdk.user('signed-in-organiser').listOptions = async (...args) => { stored.messageBody = 'Changed after loading'; stored.recipient = 'another@organiser.dev'; return realOptions(...args); };
  await fake.adapter.sendApproved(reference());
  const send = fake.calls.find(call => call.action === 'rowogelpy0h6' && call.input);
  assert.equal(send.input.messageBody, originalBody);
  assert.equal(send.input.to, 'attendee@organiser.dev');
});

test('A receipt key cannot be reused for a different approved message', async () => {
  const store = memoryStore();
  const first = fakeSDK({ store });
  await first.adapter.sendApproved(reference());
  const second = fakeSDK({ store, approval: approved({ messageBody: 'Different approved content' }) });
  await assert.rejects(second.adapter.sendApproved(reference()), GmailApprovalError);
  assert.equal(second.sends(), 0);
});

test('Disconnected, expired or wrong-account flows cannot send', async () => {
  for (const options of [{ wrongOwner: true }, { expired: true }, { flowMismatch: true }]) {
    const fake = fakeSDK(options);
    await assert.rejects(fake.adapter.sendApproved(reference()), GmailSetupError);
    assert.equal(fake.sends(), 0);
  }
});

test('Failure to persist the sending claim prevents the Gmail action', async () => {
  const store = memoryStore(); store.create = async () => { throw Error('Database unavailable'); };
  const fake = fakeSDK({ store });
  await assert.rejects(fake.adapter.sendApproved(reference()), GmailStoreError);
  assert.equal(fake.sends(), 0);
});

test('Browser-supplied message fields cannot replace the server-owned approved snapshot', async () => {
  const fake = fakeSDK();
  await fake.adapter.sendApproved({ ...reference(), recipient: 'stranger@organiser.dev', from: 'stranger@organiser.dev', subject: 'Different subject', messageBody: 'Different body' });
  const send = fake.calls.find(call => call.action === 'rowogelpy0h6' && call.input);
  assert.equal(send.input.to, fake.approval.recipient);
  assert.equal(send.input.messageBody, fake.approval.messageBody);
});

test('A multi-recipient, additional-CC or spoofed sender receipt cannot be verified', async () => {
  for (const readOverrides of [
    { to: 'attendee@organiser.dev, stranger@organiser.dev' },
    { cc: 'stranger@organiser.dev' },
    { from: 'organiser@organiser.dev text stranger@organiser.dev' },
    { labelIds: ['INBOX'] },
  ]) {
    const fake = fakeSDK({ readOverrides });
    assert.equal((await fake.adapter.sendApproved(reference())).status, 'needs-checking');
  }
});

test('A receipt-store failure after provider acceptance reports uncertainty and prevents a second send', async () => {
  const store = memoryStore(); store.update = async () => { throw Error('Database became unavailable'); };
  const fake = fakeSDK({ store });
  const result = await fake.adapter.sendApproved(reference());
  assert.equal(result.status, 'needs-checking');
  assert.equal(result.providerMessageId, 'provider-message');
  assert.equal((await fake.adapter.sendApproved(reference())).status, 'needs-checking');
  assert.equal(fake.sends(), 1);
});

test('An imported known-message receipt with an existing short approved marker reconciles by ID without sending or searching', async () => {
  const record = approved({ subject: 'ChangeRelay connection test [CR-7C42]', receiptMarker: 'CR-7C42' });
  const fake = fakeSDK({ approval: record });
  await fake.store.create(record.userId + ':' + record.receiptMarker, {
    ownerId: record.userId, receiptId: record.receiptMarker, approvalId: record.id, approvalVersion: record.version,
    approvalHash: record.hash, payloadHash: gmailApprovedPayloadHash(record), status: 'needs-checking',
    providerMessageId: 'known-provider-id', acknowledged: false,
  });
  const result = await fake.adapter.reconcile({ receiptId: record.receiptMarker });
  assert.equal(result.status, 'sent');
  assert.equal(result.providerMessageId, 'known-provider-id');
  assert.equal(fake.sends(), 0);
  assert.equal(fake.calls.some(call => call.action === 'rowr1h03w5cx'), false);
});
