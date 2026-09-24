// Plan and usage presentation, ported from the classic dashboard's billing panel.
import type { Plan, Usage, UsageFeature } from './types.ts';

const featureLabels: Record<string, [string, 'standing' | 'monthly']> = {
	inboxes: ['Inboxes', 'standing'],
	sends: ['Sends', 'monthly'],
	triage: ['Triage analyses', 'monthly'],
	custom_domains: ['Custom domains', 'standing'],
	storage_mb: ['Storage', 'standing'],
	seats: ['Seats', 'standing']
};
const number = new Intl.NumberFormat('en-US');
const date = (value: string) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export const staleBillingMessage = 'The email API is running an older version without plans. Deploy the latest API Worker, then try again.';
export const staleSettingsMessage = 'The email API is running an older version without workspace settings. Deploy the latest API Worker, then try again.';

// The API Worker rejects an operation it does not know with exactly this 404.
export function staleApiError(error: unknown, message: string, fallback: string) {
	const failure = error as { status?: number; message?: string } | undefined;
	return failure?.status === 404 && failure.message === 'Unknown dashboard operation' ? message : failure?.message || fallback;
}

export const formatAmount = (feature: string, value: number) =>
	feature === 'storage_mb' ? (value >= 1024 ? `${number.format(value / 1024)} GB` : `${number.format(value)} MB`) : number.format(value);

export type Meter = { feature: string; label: string; amount: string; share?: number; level: 'ok' | 'high' | 'spent'; note: string };

export function meter(feature: UsageFeature): Meter {
	const [label, cadence] = featureLabels[feature.feature] ?? [feature.feature, 'standing'];
	const share = !feature.unlimited && feature.granted ? Math.min(100, Math.round((feature.used / feature.granted) * 100)) : undefined;
	const notes = [];
	if (!feature.unlimited && (feature.remaining ?? 0) <= 0 && feature.granted != null) notes.push('Allowance spent.');
	if (feature.resetsAt && cadence === 'monthly') notes.push(`Resets ${date(feature.resetsAt)}.`);
	return {
		feature: feature.feature,
		label: cadence === 'monthly' ? `${label} this month` : label,
		amount: feature.unlimited
			? `${formatAmount(feature.feature, feature.used)} used, no limit`
			: `${formatAmount(feature.feature, feature.used)} of ${formatAmount(feature.feature, feature.granted ?? 0)}`,
		share,
		level: share === undefined ? 'ok' : share >= 100 ? 'spent' : share >= 80 ? 'high' : 'ok',
		note: notes.join(' ')
	};
}

// Only what the Worker meters today. Storage and seats are declared on the plans but not yet counted.
export function meters(usage: Usage): Meter[] {
	if (usage.billing === 'metered')
		return usage.features.filter((feature) => ['inboxes', 'sends', 'triage'].includes(feature.feature)).map(meter);
	const { count, limit } = usage.inboxes;
	return [meter({ feature: 'inboxes', used: count, granted: limit, remaining: limit == null ? null : limit - count, unlimited: limit == null, resetsAt: null })];
}

export function planSummary(usage: Usage) {
	const plan = usage.plan, catalog = usage.plans.find((item) => item.planId === plan?.planId), status = usage.billing;
	return {
		name: status === 'metered' ? (catalog?.name ?? plan?.planId ?? 'No plan') : status === 'exempt' ? 'Administrator' : 'Self-hosted',
		description:
			status === 'metered'
				? (catalog?.description ?? 'Your account has a plan on this deployment.')
				: status === 'exempt'
					? 'Administrator accounts are not billed. Plan limits do not apply.'
					: 'Billing is not configured on this deployment. Plan limits do not apply.',
		badge: status === 'metered' && plan ? (plan.canceledAt ? 'Cancels soon' : plan.status === 'active' ? 'Active' : plan.status) : '',
		renewal:
			status === 'metered' && plan?.currentPeriodEnd
				? `${plan.canceledAt ? 'Ends' : catalog?.price ? 'Renews' : 'Allowances reset'} ${date(plan.currentPeriodEnd)}.`
				: '',
		usageDescription:
			status === 'metered'
				? 'Sends and triage analyses reset each billing month. Inbox counts carry over. When an allowance is spent the API returns billing_limit until you upgrade or add capacity.'
				: `You have ${number.format(usage.inboxes.count)} ${usage.inboxes.count === 1 ? 'inbox' : 'inboxes'}${usage.inboxes.limit ? ` of ${number.format(usage.inboxes.limit)} allowed by the operator` : ''}. Each inbox keeps its rolling 24-hour send limit.`,
		metered: status === 'metered'
	};
}

export function includedLines(plan: Plan) {
	const rows: Array<[string, number | undefined]> = [
		['inboxes', plan.included.inboxes],
		['sends', plan.included.sends],
		['triage', plan.included.triage],
		['custom_domains', plan.included.customDomains],
		['storage_mb', plan.included.storageMb],
		['seats', plan.included.seats]
	];
	const lines = rows
		.filter((row): row is [string, number] => Boolean(row[1]))
		.map(([feature, value]) => {
			const [label, cadence] = featureLabels[feature];
			const noun = value === 1 ? label.toLowerCase().replace(/es$/, '').replace(/s$/, '') : label.toLowerCase();
			return `${formatAmount(feature, value)} ${noun}${cadence === 'monthly' ? ' a month' : ''}`;
		});
	if (plan.topUps) lines.push('$2 top-ups: one inbox, one domain, 1,000 sends, or 1,000 analyses');
	return lines;
}

export function planAction(plans: Plan[], plan: Plan, current?: string) {
	const order = plans.map((item) => item.planId);
	const upgrade = order.indexOf(plan.planId) > order.indexOf(current ?? '');
	return {
		current: plan.planId === current,
		upgrade,
		label: plan.planId === current ? 'Current plan' : upgrade ? `Upgrade to ${plan.name}` : `Switch to ${plan.name}`
	};
}
