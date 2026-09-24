import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	connectionCommand,
	draftPayload,
	encodeAttachments,
	filterInboxes,
	inboxGroups,
	mergeThreads,
	newDraft,
	paginate,
	replyTarget,
	safeDownloadUrl,
	sendOperation,
	setupAvailable,
	threadActions,
	threadItems,
	threadOperation,
	threadRequest,
	triageBadges,
	triageDetails
} from '../src/lib/services/mail.ts';
import type { Message, Triage } from '../src/lib/services/types.ts';

test('folders map to the same list requests as the classic dashboard', () => {
	assert.deepEqual(threadRequest({ inboxId: 'a@example.com', folder: 'inbox' }), {
		operation: 'listThreads',
		input: { inboxId: 'a@example.com', limit: 30, labels: ['received'], includeTrash: false }
	});
	assert.deepEqual(threadRequest({ inboxId: 'a@example.com', folder: 'all', pageToken: 'next' }).input, {
		inboxId: 'a@example.com',
		limit: 30,
		pageToken: 'next',
		includeTrash: false
	});
	assert.deepEqual(threadRequest({ inboxId: 'a@example.com', folder: 'trash' }).input, {
		inboxId: 'a@example.com',
		limit: 30,
		labels: ['trash'],
		includeTrash: true
	});
	assert.deepEqual(threadRequest({ inboxId: 'a@example.com', folder: 'quarantined' }).input, {
		inboxId: 'a@example.com',
		limit: 30,
		labels: ['quarantined'],
		includeTrash: false
	});
});

test('a search ignores the folder and keeps triage filters', () => {
	assert.deepEqual(threadRequest({ inboxId: 'a@example.com', folder: 'sent', query: '  invoice ', filters: { urgency: 'high' } }), {
		operation: 'searchMessages',
		input: { urgency: 'high', inboxId: 'a@example.com', limit: 30, query: 'invoice' }
	});
});

test('thread pages normalize senders and drop repeated threads', () => {
	const first = threadItems({ threads: [{ threadId: 't1', from: 'a@example.net', timestamp: '2026-09-01T00:00:00Z' }] });
	assert.deepEqual(first[0].senders, ['a@example.net']);
	const second = threadItems({ messages: [{ threadId: 't1', senders: ['b@example.net'], timestamp: '' }, { threadId: 't2', timestamp: '' }] });
	assert.deepEqual(mergeThreads(first, second).map((thread) => thread.threadId), ['t1', 't2']);
	assert.deepEqual(mergeThreads(first, second)[0].senders, ['a@example.net']);
});

test('quarantine reads through the review operation', () => {
	assert.equal(threadOperation('quarantined'), 'reviewThread');
	assert.equal(threadOperation('inbox'), 'getThread');
});

test('label actions follow where the conversation lives', () => {
	assert.deepEqual(threadActions(['received', 'unread']).map((action) => action.key), ['archive', 'trash']);
	assert.deepEqual(threadActions(['sent']).map((action) => action.key), ['trash', 'restore']);
	assert.deepEqual(threadActions(['received', 'trash']).map((action) => action.key), ['restore']);
	assert.deepEqual(threadActions(['trash'])[0].changes, { addLabels: ['received'], removeLabels: ['trash'] });
	assert.deepEqual(threadActions(['received', 'quarantined'], { quarantined: true }).map((action) => action.key), ['trash']);
	assert.deepEqual(threadActions(['quarantined', 'trash'], { quarantined: true }), []);
});

test('replies go to the latest received message and never to quarantined mail', () => {
	const message = (id: string, labels: string[], quarantined = false) =>
		({ messageId: id, from: '', to: [], timestamp: '', labels, ...(quarantined ? { protection: { status: 'quarantined' } } : {}) }) as Message;
	assert.equal(replyTarget([message('m1', ['received']), message('m2', ['sent'])])?.messageId, 'm1');
	assert.equal(replyTarget([message('m1', ['sent'])])?.messageId, 'm1');
	assert.equal(replyTarget([message('m1', ['received'], true)]), undefined);
	assert.equal(replyTarget([]), undefined);
});

test('triage badges and details match the classic wording', () => {
	const triage: Triage = {
		status: 'complete',
		category: { value: 'billing', confidence: 0.4, probabilities: { billing: 0.4, support: 0.6 } },
		needsReply: { value: true, probability: 0.9 },
		urgency: { value: 'critical', score: 2.8, confidence: 0.75 },
		analyzedAt: '2026-09-01T00:00:00Z'
	};
	assert.deepEqual(
		triageBadges(triage).map((badge) => [badge.label, badge.tone]),
		[['Maybe Billing', 'neutral'], ['Needs reply', 'info'], ['Critical urgency', 'danger']]
	);
	assert.equal(triageBadges({ ...triage, status: 'pending' })[0].label, 'Analysis pending');
	assert.deepEqual(triageBadges(undefined), []);
	const details = triageDetails(triage);
	assert.equal(details[2], 'Category: Support: 60% · Billing: 40%');
	assert.equal(details[3], 'Urgency: 2.80 / 3 · 75% confidence.');
});

test('inbox search, groups, and pages', () => {
	const inboxes = Array.from({ length: 23 }, (_, index) => ({
		inboxId: `agent${index}@example.com`,
		displayName: index === 3 ? 'Research assistant' : undefined,
		group: index % 2 ? 'ops' : undefined
	}));
	assert.deepEqual(inboxGroups(inboxes), ['ops']);
	assert.equal(filterInboxes(inboxes, 'research', '').length, 1);
	assert.equal(filterInboxes(inboxes, '', 'ops').length, 11);
	assert.deepEqual(paginate(inboxes, 5, 10).page, 2, 'An out-of-range page clamps to the last page');
	assert.equal(paginate(inboxes, 2, 10).items.length, 3);
	assert.equal(paginate([], 0, 10).pages, 1);
});

test('setup is offered to customer accounts while the inbox supports it', () => {
	assert.equal(setupAvailable({ authMode: 'account', hasCustomer: true }), true);
	assert.equal(setupAvailable({ authMode: 'account', hasCustomer: true, inbox: { inboxId: 'a', setupAvailable: false } }), false);
	assert.equal(setupAvailable({ authMode: 'password', hasCustomer: true }), false);
	assert.equal(setupAvailable({ authMode: 'access', hasCustomer: false }), false);
});

test('connection command targets the inbox RPC endpoint without embedding a key', () => {
	const command = connectionCommand('https://api.example.com');
	assert.match(command, /https:\/\/api\.example\.com\/inbox-rpc\/getInbox/);
	assert.match(command, /\$BEZALEL_MAILBOX_KEY/);
});

test('attachments encode to base64 and respect the size limits', async () => {
	const [encoded] = await encodeAttachments([new File(['hello'], 'note.txt', { type: 'text/plain' })]);
	assert.deepEqual(encoded, { filename: 'note.txt', contentType: 'text/plain', content: 'aGVsbG8=' });
	await assert.rejects(encodeAttachments([new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.bin')]), /2 MiB/);
	await assert.rejects(encodeAttachments(Array.from({ length: 11 }, (_, index) => new File(['x'], `${index}.txt`))), /up to 10 files/);
});

test('a draft keeps one idempotency key and chooses send or reply', async () => {
	const draft = newDraft('a@example.com');
	const payload = await draftPayload(draft, { to: 'x@example.net, y@example.net ,', subject: 'Hi', text: 'Body' });
	assert.deepEqual(payload, { inboxId: 'a@example.com', idempotencyKey: draft.id, text: 'Body', to: ['x@example.net', 'y@example.net'], subject: 'Hi' });
	assert.equal(sendOperation(draft), 'send');
	const reply = newDraft('a@example.com', { messageId: 'm1', from: '', to: [], timestamp: '' });
	assert.deepEqual(await draftPayload(reply, { text: 'Thanks' }), { inboxId: 'a@example.com', idempotencyKey: reply.id, text: 'Thanks', messageId: 'm1' });
	assert.equal(sendOperation(reply), 'reply');
	assert.notEqual(draft.id, reply.id);
});

test('download links must be plain HTTPS and may be pinned to an origin and path', () => {
	assert.equal(safeDownloadUrl('https://files.example.com/a'), 'https://files.example.com/a');
	assert.throws(() => safeDownloadUrl('http://files.example.com/a'), /Invalid attachment URL/);
	assert.throws(() => safeDownloadUrl('https://user:pass@files.example.com/a'), /Invalid attachment URL/);
	const pin = { origin: 'https://bezalel-email.michaelwasihun96.workers.dev', pathPrefix: '/attachments/' };
	assert.ok(safeDownloadUrl('https://bezalel-email.michaelwasihun96.workers.dev/attachments/x', pin));
	assert.throws(() => safeDownloadUrl('https://evil.example.com/attachments/x', pin), /Invalid attachment URL/);
	assert.throws(() => safeDownloadUrl('https://bezalel-email.michaelwasihun96.workers.dev/other', pin), /Invalid attachment URL/);
});
