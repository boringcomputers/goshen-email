// Shapes returned by the dashboard server's /api/rpc operations.

export type Customer = {
	id: string;
	email: string;
	displayName?: string;
	organizationName?: string;
	role?: string;
	inboxLimit?: number | null;
	desktopNotifications?: boolean;
	emailNotifications?: boolean;
	notificationCursor?: string | null;
};

export type Inbox = {
	inboxId: string;
	address?: string;
	displayName?: string;
	group?: string;
	deliveryStatus?: 'pending' | 'ready';
	setupAvailable?: boolean;
	createdAt?: string;
};

export type Triage = {
	status: 'pending' | 'complete' | 'failed';
	category: { value: string; confidence: number; probabilities: Record<string, number> };
	needsReply: { value: boolean | null; probability: number };
	urgency: { value: string | null; score: number; confidence: number };
	analyzedAt: string;
	bodyTruncated?: boolean;
};

export type ThreadSummary = {
	threadId: string;
	subject?: string;
	preview?: string;
	senders: string[];
	from?: string;
	timestamp: string;
	labels?: string[];
	triage?: Triage;
};

export type Attachment = { attachmentId: string; filename: string; size: number; contentType?: string };

export type Protection = {
	status: string;
	antivirus: { status: string };
	authentication: { spf: string; dkim: string; dmarc: string };
	spam: { score: number; threshold: number };
	reasons: string[];
	releasedAt?: string;
};

export type Delivery = { recipients: Array<{ recipient: string; status: string; reason?: string }> };

export type Message = {
	messageId: string;
	threadId?: string;
	from: string;
	to: string[];
	cc?: string[];
	timestamp: string;
	subject?: string;
	preview?: string;
	text?: string;
	labels?: string[];
	attachments?: Attachment[];
	triage?: Triage;
	protection?: Protection;
	delivery?: Delivery;
};

export type Thread = {
	threadId: string;
	subject?: string;
	messageCount: number;
	labels: string[];
	messages: Message[];
};

export type Domain = {
	domainId: string;
	domain?: string;
	status: string;
	records: Array<{ type: string; name: string; value: string; priority?: number; status?: string }>;
};

export type ApiKey = {
	keyId: string;
	name: string;
	prefix: string;
	scopes: string[];
	expiresAt?: string | null;
	revokedAt?: string | null;
};

export type SetupStatus = { deliveryReady?: boolean; connectedAt?: string | null; receivedAt?: string | null };

export type UsageFeature = {
	feature: string;
	used: number;
	granted?: number | null;
	remaining?: number | null;
	unlimited?: boolean;
	resetsAt?: string | null;
};

export type Plan = {
	planId: string;
	name: string;
	price: number;
	description: string;
	topUps?: boolean;
	included: { inboxes?: number; sends?: number; triage?: number; customDomains?: number; storageMb?: number; seats?: number };
};

export type Usage = {
	billing: 'metered' | 'exempt' | 'unmetered' | string;
	plan?: { planId: string; status: string; canceledAt?: string | null; currentPeriodEnd?: string | null } | null;
	plans: Plan[];
	features: UsageFeature[];
	inboxes: { count: number; limit?: number | null };
};
