<script lang="ts">
	import { goto } from '$app/navigation';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Badge } from '$lib/components/ds/badge';
	import { Button } from '$lib/components/ds/button';
	import { InlineAlert, SectionHeader } from '$lib/components/ds/patterns';
	import { Progress } from '$lib/components/ds/progress';
	import { Skeleton } from '$lib/components/ds/skeleton';
	import PageShell from '$lib/components/PageShell.svelte';
	import { includedLines, meters, planAction, planSummary, staleApiError, staleBillingMessage } from '$lib/services/billing';
	import type { Plan, Usage } from '$lib/services/types';
	import { useWorkspace } from '$lib/workspace.svelte';

	const workspace = useWorkspace();

	let usage = $state<Usage | null>(null);
	let error = $state('');
	let busy = $state('');
	let version = 0;

	const summary = $derived(usage ? planSummary(usage) : null);
	const usageMeters = $derived(usage ? meters(usage) : []);
	const failure = (reason: unknown) => staleApiError(reason, staleBillingMessage, 'Usage request failed');

	// A reload supersedes any checkout or portal request still in flight, so the buttons come back.
	async function load({ fresh = false } = {}) {
		const requestVersion = ++version;
		busy = '';
		error = '';
		if (fresh) usage = null;
		try {
			const result = await workspace.rpc<Usage>('getUsage');
			if (requestVersion === version) usage = result;
		} catch (reason) {
			if (requestVersion === version) error = failure(reason);
		}
	}

	onMount(() => {
		if (!workspace.isCustomer) void goto('/inboxes', { replaceState: true });
		else void load();
	});

	async function checkout(plan: Plan) {
		if (busy) return;
		busy = plan.planId;
		const requestVersion = version;
		try {
			const { paymentUrl } = await workspace.rpc<{ paymentUrl?: string }>('startCheckout', { planId: plan.planId });
			if (requestVersion !== version) return;
			if (paymentUrl) return location.assign(paymentUrl);
			toast.success(`Plan changed to ${plan.name}.`);
			await load();
		} catch (reason) {
			if (requestVersion !== version) return;
			busy = '';
			error = failure(reason);
		}
	}

	async function portal() {
		if (busy) return;
		busy = 'portal';
		const requestVersion = version;
		try {
			const { url } = await workspace.rpc<{ url: string }>('openBillingPortal');
			if (requestVersion === version) location.assign(url);
		} catch (reason) {
			if (requestVersion !== version) return;
			busy = '';
			error = failure(reason);
		}
	}

	const levelClass = { ok: '', high: '[&>div]:bg-[var(--status-warning-fg)]', spent: '[&>div]:bg-[var(--status-danger-fg)]' };
</script>

<svelte:head>
	<title>Plan and usage · Goshen Email</title>
</svelte:head>

<PageShell title="Plan and usage" description="What your plan includes and what your agents have used this month.">
	{#snippet actions()}
		<Button variant="ghost" size="icon" aria-label="Refresh usage" title="Refresh usage" onclick={() => load({ fresh: true })}>
			<RefreshCwIcon aria-hidden="true" />
		</Button>
	{/snippet}

	<div class="mt-3 max-w-4xl space-y-4">
		{#if error}
			<InlineAlert tone="danger">
				{error}
				{#snippet actions()}<Button variant="secondary" size="sm" onclick={() => load()}>Try again</Button>{/snippet}
			</InlineAlert>
		{/if}

		{#if !usage && !error}
			<Skeleton class="h-28 w-full" />
			<Skeleton class="h-40 w-full" />
		{:else if usage && summary}
			<section class="rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)]">
				<div class="space-y-1 p-4">
					<div class="flex items-center gap-2">
						<span class="text-[12px] font-medium uppercase tracking-[0.01em] text-[var(--muted-fg)]">Current plan</span>
						{#if summary.badge}
							<Badge variant={summary.badge === 'Active' ? 'emerald' : 'amber'} size="sm">{summary.badge}</Badge>
						{/if}
					</div>
					<p class="text-[16px] font-medium tracking-[-0.01em] text-foreground" data-testid="plan-name">{summary.name}</p>
					<p class="text-[13px] text-[var(--muted-fg)]">{summary.description}</p>
					{#if summary.renewal}<p class="text-[12px] text-[var(--muted-fg)]">{summary.renewal}</p>{/if}
				</div>
				<footer class="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--ds-border)] px-4 py-3">
					<span class="text-[12px] text-[var(--muted-fg)]">Payment, receipts, top-ups, and cancellation are handled on the billing page.</span>
					{#if summary.metered}
						<Button variant="outline" size="sm" disabled={busy === 'portal'} onclick={portal}>
							{busy === 'portal' ? 'Opening…' : 'Manage billing'}
						</Button>
					{/if}
				</footer>
			</section>

			<section class="space-y-3">
				<SectionHeader title="Usage" description={summary.usageDescription} />
				<ul class="grid gap-3 md:grid-cols-3" aria-label="Usage by feature">
					{#each usageMeters as item (item.feature)}
						<li class="flex flex-col rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)] p-4">
							<span class="text-[12px] font-medium uppercase tracking-[0.01em] text-[var(--muted-fg)]">{item.label}</span>
							<span class="mt-1 text-[14px] font-medium tracking-[-0.01em] text-foreground tabular-nums">{item.amount}</span>
							{#if item.share !== undefined}
								<Progress value={item.share} label={item.label} class="mt-3 {levelClass[item.level]}" />
							{/if}
							{#if item.note}<span class="mt-2 text-[12px] text-[var(--muted-fg)]">{item.note}</span>{/if}
						</li>
					{/each}
				</ul>
			</section>

			{#if summary.metered && usage.plans.length}
				<section class="space-y-3">
					<SectionHeader
						title="Plans"
						description="Upgrades take effect right away. Paid plans add $2 top-ups for one inbox, one domain, 1,000 sends, or 1,000 triage analyses a month."
					/>
					<div class="grid gap-3 md:grid-cols-3">
						{#each usage.plans as plan (plan.planId)}
							{@const action = planAction(usage.plans, plan, usage.plan?.planId)}
							<article
								class="flex flex-col gap-3 rounded-[var(--radius-card)] border bg-[var(--surface)] p-4 {action.current
									? 'border-[var(--accent)]'
									: 'border-[var(--ds-border)]'}"
								aria-labelledby={`plan-${plan.planId}`}
							>
								<div class="flex items-center justify-between gap-2">
									<h3 id={`plan-${plan.planId}`} class="text-[14px] font-medium text-foreground">{plan.name}</h3>
									{#if action.current}<Badge variant="blue" size="sm">Current plan</Badge>{/if}
								</div>
								<p>
									<span class="text-[24px] font-semibold tracking-[-0.02em] text-foreground tabular-nums">${plan.price}</span>
									<span class="text-[12px] text-[var(--muted-fg)]">{plan.price ? ' per month' : ' forever'}</span>
								</p>
								<p class="text-[13px] text-[var(--muted-fg)]">{plan.description}</p>
								<ul class="space-y-1 text-[12px] text-[var(--muted-fg)]">
									{#each includedLines(plan) as line (line)}<li>· {line}</li>{/each}
								</ul>
								<Button
									class="mt-auto"
									variant={action.upgrade ? 'default' : 'secondary'}
									disabled={action.current || busy !== ''}
									onclick={() => checkout(plan)}
								>
									{busy === plan.planId ? 'Opening checkout…' : action.label}
								</Button>
							</article>
						{/each}
					</div>
				</section>
			{/if}
		{/if}
	</div>
</PageShell>
