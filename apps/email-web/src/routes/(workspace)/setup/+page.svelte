<script lang="ts">
	import { goto } from '$app/navigation';
	import MailIcon from '@lucide/svelte/icons/mail';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Badge } from '$lib/components/ds/badge';
	import { Button } from '$lib/components/ds/button';
	import { Input } from '$lib/components/ds/input';
	import { FormField, InlineAlert, Stepper } from '$lib/components/ds/patterns';
	import PageShell from '$lib/components/PageShell.svelte';
	import { dismissSetup } from '$lib/components/setup/dismissal';
	import type { SetupStatus } from '$lib/services/types';
	import { useWorkspace } from '$lib/workspace.svelte';

	const workspace = useWorkspace();

	let displayName = $state('');
	let username = $state('');
	let busy = $state('');
	let error = $state('');
	let status = $state<SetupStatus | null>(null);
	let version = 0;

	const inbox = $derived(workspace.currentInbox);
	const domain = $derived(workspace.session?.defaultDomain ?? '');
	const ready = $derived(status?.deliveryReady ?? inbox?.deliveryStatus === 'ready');
	const complete = $derived(Boolean(status?.connectedAt || status?.receivedAt));
	const steps = $derived([Boolean(inbox), Boolean(inbox && ready), complete]);
	const firstOpenStep = $derived(steps.findIndex((done) => !done));
	const current = $derived(firstOpenStep === -1 ? steps.length : firstOpenStep);
	const preview = $derived(username.trim() && domain ? `${username.trim().toLowerCase()}@${domain}` : '');

	$effect(() => {
		if (!workspace.showSetup) void goto('/inboxes', { replaceState: true });
	});

	async function refresh() {
		const inboxId = workspace.currentInboxId, requestVersion = ++version;
		status = null;
		if (!inboxId || !workspace.currentInbox?.setupAvailable) return;
		try {
			const result = await workspace.rpc<SetupStatus>('setupStatus', { inboxId });
			if (requestVersion === version && inboxId === workspace.currentInboxId) status = result;
		} catch (failure) {
			if (requestVersion === version) error = failure instanceof Error ? failure.message : 'Setup status could not load.';
		}
	}

	$effect(() => {
		void workspace.currentInboxId;
		untrack(() => void refresh());
	});

	async function run(key: string, task: () => Promise<void>) {
		if (busy) return;
		busy = key;
		error = '';
		try {
			await task();
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'Something went wrong. Try again.';
		} finally {
			busy = '';
		}
	}

	function create(event: SubmitEvent) {
		event.preventDefault();
		void run('create', async () => {
			await workspace.createInbox({
				username: username.trim().toLowerCase(),
				...(displayName.trim() ? { displayName: displayName.trim() } : {})
			});
			displayName = username = '';
		});
	}

	function leave() {
		if (workspace.customer) dismissSetup(workspace.customer.id);
		void goto(inbox ? `/inboxes/${encodeURIComponent(inbox.inboxId)}` : '/inboxes');
	}
</script>

<svelte:head>
	<title>Get started · Goshen Email</title>
</svelte:head>

<PageShell title="A home for your next conversation." description="Create an address for yourself or your agent. Your first inbox starts here.">
	<div class="mx-auto mt-6 w-full max-w-2xl">
		<Stepper steps={['Choose your address', 'Get ready for mail', 'Make it yours']} {current} class="mb-6" />

		<div class="rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)] p-6">
			{#if !inbox}
				<form class="space-y-4" onsubmit={create}>
					<div class="flex items-center gap-3">
						<span class="flex size-9 items-center justify-center rounded-[8px] border border-[var(--ds-border)] bg-[var(--surface-2)] text-[var(--muted-fg)]">
							<MailIcon class="size-4" aria-hidden="true" />
						</span>
						<div>
							<h2 class="text-[14px] font-medium text-foreground">Your first inbox</h2>
							<p class="text-[13px] text-[var(--muted-fg)]">Give it a name you will recognize. You can add more inboxes later.</p>
						</div>
					</div>
					<FormField label="Inbox name" for="setup-name" hint="Optional">
						<Input id="setup-name" bind:value={displayName} maxlength={200} placeholder="Research assistant" autocomplete="off" />
					</FormField>
					<FormField label="Email username" for="setup-username" required hint={preview}>
						<div class="flex items-center gap-2">
							<Input
								id="setup-username"
								bind:value={username}
								required
								maxlength={64}
								pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]*"
								placeholder="research"
								autocomplete="off"
								autocapitalize="none"
								spellcheck={false}
							/>
							{#if domain}<span class="shrink-0 text-[13px] text-[var(--muted-fg)]">@{domain}</span>{/if}
						</div>
					</FormField>
					{#if !domain}
						<InlineAlert tone="warning">Email addresses are not available yet. Please try again later.</InlineAlert>
					{/if}
					<Button type="submit" disabled={!domain || busy === 'create'}>{busy === 'create' ? 'Creating inbox…' : 'Create inbox'}</Button>
				</form>
			{:else}
				<div class="space-y-4">
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0">
							<h2 class="truncate text-[14px] font-medium text-foreground">{inbox.displayName || 'Your inbox'}</h2>
							<p class="truncate text-[13px] text-[var(--muted-fg)]" data-testid="setup-address">{inbox.address}</p>
						</div>
						<Badge variant={ready ? 'emerald' : 'amber'} size="sm">{ready ? 'Delivery configured' : 'Setup pending'}</Badge>
					</div>
					<p class="text-[13px] text-[var(--muted-fg)]" role="status">
						{ready
							? 'Your address is set up. Try it from another email account or connect your agent below.'
							: 'Your address is reserved. Delivery setup has not finished yet. Retry to keep setting up this same inbox.'}
					</p>
					{#if !ready}
						<Button
							disabled={busy === 'retry'}
							onclick={() =>
								run('retry', async () => {
									try {
										await workspace.rpc('finishInboxSetup', { inboxId: inbox.inboxId });
									} finally {
										await workspace.loadInboxes();
									}
									await refresh();
								})}
						>
							Retry delivery setup
						</Button>
					{:else}
						<div class="grid gap-3 md:grid-cols-2">
							<section class="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--ds-border)] p-4">
								<h3 class="text-[13px] font-medium text-foreground">Try your new address</h3>
								<p class="text-[12px] text-[var(--muted-fg)]">Send an email here from another account, then check for it.</p>
								<div class="mt-auto flex flex-wrap gap-2 pt-1">
									<Button
										size="sm"
										variant="secondary"
										onclick={() =>
											run('copy', async () => {
												await navigator.clipboard.writeText(inbox.address || inbox.inboxId);
												toast.success('Address copied');
											})}>Copy address</Button
									>
									<Button size="sm" variant="secondary" disabled={busy === 'check'} onclick={() => run('check', refresh)}>Check for email</Button>
								</div>
								<p class="text-[12px] text-[var(--muted-fg)]" role="status">
									{status?.receivedAt ? 'Email received. Your address is working.' : 'No email received yet.'}
								</p>
							</section>
							<section class="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--ds-border)] p-4">
								<h3 class="text-[13px] font-medium text-foreground">Connect your agent</h3>
								<p class="text-[12px] text-[var(--muted-fg)]">
									Use an account API key across all your inboxes, or a mailbox key limited to this one.
								</p>
								<div class="mt-auto pt-1">
									<Button size="sm" variant="secondary" onclick={() => (workspace.credentialsFor = inbox.inboxId)}>Get a mailbox key</Button>
								</div>
								<p class="text-[12px] text-[var(--muted-fg)]" role="status">
									{status?.connectedAt ? 'Connection verified with the current API key.' : 'Agent connection is optional.'}
								</p>
							</section>
						</div>
					{/if}
				</div>
			{/if}
			{#if error}<p class="mt-3 text-[12px] text-[var(--status-danger-fg)]" role="alert">{error}</p>{/if}
		</div>

		<footer class="mt-4 flex items-center justify-between gap-3 text-[12px] text-[var(--muted-fg)]">
			<span>
				{complete ? 'Your inbox is ready. Pick up the conversation whenever you like.' : 'You can use your inbox in the browser or through the API.'}
			</span>
			<Button variant="ghost" size="sm" onclick={leave}>{inbox ? 'Go to inbox' : 'Set up later'}</Button>
		</footer>
	</div>
</PageShell>
