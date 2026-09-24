import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAmount, includedLines, meters, planAction, planSummary, staleApiError, staleBillingMessage } from '../src/lib/services/billing.ts';
import type { Plan, Usage } from '../src/lib/services/types.ts';

const plans: Plan[] = [
	{ planId: 'free', name: 'Free', price: 0, description: 'Try it out.', included: { inboxes: 1, sends: 100, triage: 50 } },
	{ planId: 'pro', name: 'Pro', price: 20, description: 'For teams.', topUps: true, included: { inboxes: 10, sends: 5000, storageMb: 2048 } }
];

test('metered usage shows only the counted features and their levels', () => {
	const usage: Usage = {
		billing: 'metered',
		plan: { planId: 'free', status: 'active', currentPeriodEnd: '2026-10-01T12:00:00Z' },
		plans,
		inboxes: { count: 1 },
		features: [
			{ feature: 'inboxes', used: 1, granted: 1, remaining: 0 },
			{ feature: 'sends', used: 85, granted: 100, remaining: 15, resetsAt: '2026-10-01T12:00:00Z' },
			{ feature: 'triage', used: 3, granted: 50, remaining: 47 },
			{ feature: 'storage_mb', used: 10, granted: 100, remaining: 90 }
		]
	};
	const result = meters(usage);
	assert.deepEqual(result.map((item) => item.feature), ['inboxes', 'sends', 'triage']);
	assert.deepEqual([result[0].level, result[0].note], ['spent', 'Allowance spent.']);
	assert.deepEqual([result[1].label, result[1].amount, result[1].level], ['Sends this month', '85 of 100', 'high']);
	assert.match(result[1].note, /^Resets Oct 1, 2026\.$/);
	const summary = planSummary(usage);
	assert.deepEqual([summary.name, summary.badge, summary.metered], ['Free', 'Active', true]);
	assert.equal(summary.renewal, 'Allowances reset Oct 1, 2026.');
});

test('self-hosted and administrator accounts are not billed', () => {
	const selfHosted: Usage = { billing: 'unmetered', plans: [], features: [], inboxes: { count: 2, limit: null } };
	assert.equal(planSummary(selfHosted).name, 'Self-hosted');
	assert.deepEqual(meters(selfHosted).map((item) => [item.amount, item.share]), [['2 used, no limit', undefined]]);
	assert.match(planSummary(selfHosted).usageDescription, /^You have 2 inboxes\./);
	assert.equal(planSummary({ ...selfHosted, billing: 'exempt' }).name, 'Administrator');
});

test('plan cards describe allowances and the direction of a change', () => {
	assert.deepEqual(includedLines(plans[0]), ['1 inbox', '100 sends a month', '50 triage analyses a month']);
	assert.deepEqual(includedLines(plans[1]).slice(-2), ['2 GB storage', '$2 top-ups: one inbox, one domain, 1,000 sends, or 1,000 analyses']);
	assert.deepEqual(planAction(plans, plans[1], 'free'), { current: false, upgrade: true, label: 'Upgrade to Pro' });
	assert.deepEqual(planAction(plans, plans[0], 'pro'), { current: false, upgrade: false, label: 'Switch to Free' });
	assert.equal(planAction(plans, plans[0], 'free').label, 'Current plan');
	assert.equal(formatAmount('storage_mb', 512), '512 MB');
});

test('an older API Worker gets an explanation instead of its 404', () => {
	assert.equal(staleApiError({ status: 404, message: 'Unknown dashboard operation' }, staleBillingMessage, 'x'), staleBillingMessage);
	assert.equal(staleApiError({ status: 404, message: 'Inbox not found' }, staleBillingMessage, 'x'), 'Inbox not found');
	assert.equal(staleApiError(undefined, staleBillingMessage, 'fallback'), 'fallback');
});
