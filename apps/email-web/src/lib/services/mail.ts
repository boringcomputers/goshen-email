// Mail mechanics shared by the inbox list, the mail view, the setup guide, and the Bezalel reader.
import type { Delivery, Inbox, Message, Protection, ThreadSummary, Triage } from './types.ts';

export type Folder = 'inbox' | 'sent' | 'all' | 'quarantined' | 'trash';
export type TriageFilters = { category?: string; needsReply?: string; urgency?: string };

export const folders: Array<{ key: Folder; label: string }> = [
	{ key: 'inbox', label: 'Inbox' },
	{ key: 'sent', label: 'Sent' },
	{ key: 'all', label: 'All mail' },
	{ key: 'quarantined', label: 'Quarantine' },
	{ key: 'trash', label: 'Trash' }
];

export const triageOptions = {
	category: [['billing', 'Billing'], ['support', 'Support'], ['sales', 'Sales'], ['personal', 'Personal'], ['notification', 'Notification'], ['other', 'Other']],
	needsReply: [['yes', 'Needs reply'], ['no', 'No reply'], ['uncertain', 'Unclear']],
	urgency: [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['critical', 'Critical']]
} as const;

export const customerMode = (authMode?: string) => authMode === 'account' || authMode === 'access';

// A search runs across the whole inbox; otherwise the folder picks the label and whether trash counts.
export function threadRequest({ inboxId, folder, query, filters = {}, pageToken, limit = 30 }: {
	inboxId: string;
	folder: Folder;
	query?: string;
	filters?: TriageFilters;
	pageToken?: string;
	limit?: number;
}) {
	const search = query?.trim();
	return {
		operation: search ? 'searchMessages' : 'listThreads',
		input: {
			...filters,
			inboxId,
			limit,
			...(pageToken ? { pageToken } : {}),
			...(search
				? { query: search }
				: { ...(folder === 'all' ? {} : { labels: [folder === 'inbox' ? 'received' : folder] }), includeTrash: folder === 'trash' })
		}
	};
}

type ThreadPage = { threads?: Partial<ThreadSummary>[]; messages?: Partial<ThreadSummary>[]; nextPageToken?: string };

export function threadItems(result: ThreadPage): ThreadSummary[] {
	return (result.threads ?? result.messages ?? []).map(
		(item) => ({ ...item, senders: item.senders ?? (item.from ? [item.from] : []) }) as ThreadSummary
	);
}

// Appending a page can repeat a thread that moved; keep its first position.
export function mergeThreads(current: ThreadSummary[], next: ThreadSummary[]): ThreadSummary[] {
	const seen = new Set<string>();
	return [...current, ...next].filter((thread) => {
		if (seen.has(thread.threadId)) return false;
		seen.add(thread.threadId);
		return true;
	});
}

export const threadOperation = (folder: Folder) => (folder === 'quarantined' ? 'reviewThread' : 'getThread');

export type LabelAction = { key: 'archive' | 'trash' | 'restore'; label: string; changes: { addLabels?: string[]; removeLabels?: string[] } };

// Quarantined mail leaves quarantine only through release, so its folder offers trash alone.
export function threadActions(labels: string[] = [], { quarantined = false } = {}): LabelAction[] {
	const received = labels.includes('received'), trashed = labels.includes('trash');
	const actions: LabelAction[] = [];
	if (quarantined) return trashed ? [] : [{ key: 'trash', label: 'Move to trash', changes: { addLabels: ['trash'] } }];
	if (received && !trashed) actions.push({ key: 'archive', label: 'Archive', changes: { removeLabels: ['received'] } });
	if (!trashed) actions.push({ key: 'trash', label: 'Move to trash', changes: { addLabels: ['trash'] } });
	if (trashed || !received)
		actions.push({ key: 'restore', label: 'Move to inbox', changes: { addLabels: ['received'], removeLabels: ['trash'] } });
	return actions;
}

// Reply to the latest message someone sent this inbox, or the latest message when there is none.
export function replyTarget(messages: Message[]): Message | undefined {
	const target = messages.findLast((message) => message.labels?.includes('received')) ?? messages.at(-1);
	return target && target.protection?.status !== 'quarantined' ? target : undefined;
}

const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const percent = (value: number) => `${Math.round(value * 100)}%`;

export type TriageBadge = { label: string; tone: 'neutral' | 'info' | 'warning' | 'danger'; title?: string };

export function triageBadges(triage?: Triage): TriageBadge[] {
	if (!triage) return [];
	if (triage.status !== 'complete')
		return [{ label: triage.status === 'pending' ? 'Analysis pending' : 'Analysis unavailable', tone: 'neutral' }];
	const reply = triage.needsReply.value, urgency = triage.urgency.value;
	return [
		{
			label: `${triage.category.confidence < 0.5 ? 'Maybe ' : ''}${title(triage.category.value)}`,
			tone: 'neutral',
			title: `Category confidence: ${percent(triage.category.confidence)}`
		},
		{ label: reply === null ? 'Reply unclear' : reply ? 'Needs reply' : 'No reply needed', tone: reply ? 'info' : 'neutral' },
		{
			label: urgency ? `${title(urgency)} urgency` : 'Urgency unclear',
			tone: urgency === 'critical' ? 'danger' : urgency === 'high' ? 'warning' : 'neutral'
		}
	];
}

export function triageDetails(triage: Triage): string[] {
	if (triage.status !== 'complete')
		return [triage.status === 'pending' ? 'Analysis is queued. Refresh in a moment to see the result.' : 'Analysis could not finish. Your email is still available.'];
	const distribution = Object.entries(triage.category.probabilities)
		.sort((a, b) => b[1] - a[1])
		.map(([category, probability]) => `${title(category)}: ${percent(probability)}`)
		.join(' · ');
	return [
		'Suggestions describe this message when it arrived. Check the conversation before acting.',
		`Reply needed: ${percent(triage.needsReply.probability)} probability.`,
		`Category: ${distribution}`,
		`Urgency: ${triage.urgency.score.toFixed(2)} / 3 · ${percent(triage.urgency.confidence)} confidence.`,
		`Analyzed ${new Date(triage.analyzedAt).toLocaleString()}${triage.bodyTruncated ? ' · Only the beginning of this long message was analyzed.' : ''}`
	];
}

export const deliveryLines = (delivery: Delivery) =>
	delivery.recipients.map((recipient) => `${recipient.recipient}: ${recipient.status}${recipient.reason ? ` · ${recipient.reason}` : ''}`);

export const protectionLines = (protection: Protection) => [
	`Attachment scan: ${protection.antivirus.status}`,
	`SPF: ${protection.authentication.spf} · DKIM: ${protection.authentication.dkim} · DMARC: ${protection.authentication.dmarc}`,
	`Spam score: ${protection.spam.score} / ${protection.spam.threshold}`,
	...protection.reasons.map((reason) => reason.replaceAll('_', ' ')),
	...(protection.releasedAt ? [`Released: ${new Date(protection.releasedAt).toLocaleString()}`] : [])
];

export const inboxGroups = (inboxes: Inbox[]) => [...new Set(inboxes.map((inbox) => inbox.group).filter((group): group is string => Boolean(group)))].sort();

export function filterInboxes(inboxes: Inbox[], query: string, group: string): Inbox[] {
	const search = query.trim().toLowerCase();
	return inboxes.filter(
		(inbox) =>
			(!group || inbox.group === group) &&
			[inbox.inboxId, inbox.displayName, inbox.group].filter(Boolean).join(' ').toLowerCase().includes(search)
	);
}

export function paginate<T>(items: T[], page: number, size: number) {
	const pages = Math.max(1, Math.ceil(items.length / size));
	const current = Math.min(Math.max(0, page), pages - 1);
	return { items: items.slice(current * size, (current + 1) * size), page: current, pages };
}

export const inboxLabel = (inbox: Inbox) => `${inbox.group ? `[${inbox.group}] ` : ''}${inbox.inboxId}${inbox.deliveryStatus === 'pending' ? ' (setup pending)' : ''}`;

export function setupAvailable({ authMode, hasCustomer, inbox }: { authMode?: string; hasCustomer: boolean; inbox?: Inbox }) {
	return customerMode(authMode) && hasCustomer && (!inbox || inbox.setupAvailable === true);
}

export function connectionCommand(apiUrl: string) {
	const url = new URL('/inbox-rpc/getInbox', apiUrl);
	return `curl --fail-with-body '${url.href}' \\\n  -H "Authorization: Bearer $BEZALEL_MAILBOX_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d '{}'`;
}

export const maxAttachmentFiles = 10;
export const maxAttachmentBytes = 2 * 1024 * 1024;

export async function encodeAttachments(files: File[]) {
	if (files.length > maxAttachmentFiles || files.reduce((sum, file) => sum + file.size, 0) > maxAttachmentBytes)
		throw new Error('Choose up to 10 files, with a combined size of 2 MiB or less.');
	return Promise.all(
		files.map(async (file) => {
			const bytes = new Uint8Array(await file.arrayBuffer());
			let text = '';
			for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192));
			return { filename: file.name, contentType: file.type || 'application/octet-stream', content: btoa(text) };
		})
	);
}

// A draft keeps one idempotency key for its whole life. Once a send is attempted, the payload is
// frozen so a retry repeats the exact request and the Worker can recognise a send it already took.
export type Draft = { id: string; inboxId: string; replyTo?: Message; payload?: Record<string, unknown> };

export const newDraft = (inboxId: string, replyTo?: Message): Draft => ({ id: crypto.randomUUID(), inboxId, replyTo });

export async function draftPayload(draft: Draft, fields: { to?: string; subject?: string; text: string; files?: File[] }) {
	const attachments = await encodeAttachments(fields.files ?? []);
	return {
		inboxId: draft.inboxId,
		idempotencyKey: draft.id,
		text: fields.text,
		...(attachments.length ? { attachments } : {}),
		...(draft.replyTo
			? { messageId: draft.replyTo.messageId }
			: {
					to: (fields.to ?? '').split(',').map((address) => address.trim()).filter(Boolean),
					subject: fields.subject ?? ''
				})
	};
}

export const sendOperation = (draft: Draft) => (draft.replyTo ? 'reply' : 'send');

export function initials(value: string) {
	return (
		value
			.replace(/@.*/, '')
			.split(/[\s._-]+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((word) => word[0])
			.join('')
			.toUpperCase() || 'G'
	);
}

export function safeDownloadUrl(value: string, { origin, pathPrefix }: { origin?: string; pathPrefix?: string } = {}) {
	const url = new URL(value);
	if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid attachment URL');
	if (origin && url.origin !== origin) throw new Error('Invalid attachment URL');
	if (pathPrefix && !url.pathname.startsWith(pathPrefix)) throw new Error('Invalid attachment URL');
	return url.href;
}
