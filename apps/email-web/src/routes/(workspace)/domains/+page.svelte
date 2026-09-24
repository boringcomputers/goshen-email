<script lang="ts">
	import { goto } from '$app/navigation';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Badge, type BadgeVariant } from '$lib/components/ds/badge';
	import { Button } from '$lib/components/ds/button';
	import * as Dialog from '$lib/components/ds/dialog/index.js';
	import { Input } from '$lib/components/ds/input';
	import { ConfirmDialog, FormField, InlineAlert, PageEmptyState } from '$lib/components/ds/patterns';
	import { Skeleton } from '$lib/components/ds/skeleton';
	import PageShell from '$lib/components/PageShell.svelte';
	import type { Domain } from '$lib/services/types';
	import { useWorkspace } from '$lib/workspace.svelte';

	const workspace = useWorkspace();

	let domains = $state<Domain[] | null>(null);
	let error = $state('');
	let busy = $state('');
	let adding = $state(false);
	let newDomain = $state('');
	let addError = $state('');
	let removing = $state<Domain | null>(null);

	const statusVariant = (status: string): BadgeVariant =>
		status.toUpperCase() === 'VERIFIED' ? 'emerald' : status.toUpperCase() === 'FAILED' ? 'red' : 'amber';

	async function load() {
		error = '';
		try {
			domains = await workspace.rpc<Domain[]>('listDomains');
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'Domains could not load.';
		}
	}

	onMount(() => {
		if (!workspace.showDomains) void goto('/inboxes', { replaceState: true });
		else void load();
	});

	async function act(domain: Domain, operation: 'verifyDomain' | 'deleteDomain') {
		busy = `${operation}:${domain.domainId}`;
		error = '';
		try {
			await workspace.rpc(operation, { domainId: domain.domainId });
			toast.success(operation === 'deleteDomain' ? 'Domain removed' : 'DNS checked');
			await load();
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'The domain request failed.';
		} finally {
			busy = '';
		}
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		busy = 'add';
		addError = '';
		try {
			await workspace.rpc('createDomain', { domain: newDomain.trim() });
			adding = false;
			newDomain = '';
			await load();
		} catch (failure) {
			addError = failure instanceof Error ? failure.message : 'The domain could not be added.';
		} finally {
			busy = '';
		}
	}
</script>

<svelte:head>
	<title>Domains · Goshen Email</title>
</svelte:head>

<PageShell title="Domains" description="Send and receive email on your own domain.">
	{#snippet actions()}
		<Button
			onclick={() => {
				addError = '';
				adding = true;
			}}><PlusIcon aria-hidden="true" /> Add domain</Button
		>
	{/snippet}

	<div class="mt-3 space-y-3">
		{#if error}<InlineAlert tone="danger">{error}</InlineAlert>{/if}
		{#if domains === null && !error}
			<Skeleton class="h-24 w-full" />
		{:else if domains?.length === 0}
			<PageEmptyState title="No domains yet" description="Connect a domain by adding its DNS records. Custom domains require a configured SMTP gateway.">
				{#snippet icon()}<GlobeIcon class="size-4" aria-hidden="true" />{/snippet}
			</PageEmptyState>
		{:else}
			{#each domains ?? [] as domain (domain.domainId)}
				<section class="rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)]" data-domain-id={domain.domainId}>
					<header class="flex flex-wrap items-center gap-3 px-4 py-3">
						<GlobeIcon class="size-4 text-[var(--muted-fg)]" aria-hidden="true" />
						<h2 class="text-[14px] font-medium text-foreground">{domain.domain ?? domain.domainId}</h2>
						<Badge variant={statusVariant(domain.status)} size="sm">{domain.status}</Badge>
						<div class="ml-auto flex gap-2">
							<Button size="sm" variant="outline" disabled={busy !== ''} onclick={() => act(domain, 'verifyDomain')}>
								{busy === `verifyDomain:${domain.domainId}` ? 'Checking…' : 'Verify DNS'}
							</Button>
							<Button size="sm" variant="ghost" disabled={busy !== ''} onclick={() => (removing = domain)}>Remove</Button>
						</div>
					</header>
					{#if domain.records.length}
						<div class="overflow-x-auto border-t border-[var(--ds-border)]">
							<table class="w-full border-collapse text-[12px]">
								<thead>
									<tr>
										{#each ['Type', 'Name', 'Value', 'Status'] as label (label)}
											<th scope="col" class="border-b border-[var(--ds-border)] px-4 py-2 text-left text-[11px] font-medium uppercase text-[var(--muted-fg)]">{label}</th>
										{/each}
									</tr>
								</thead>
								<tbody>
									{#each domain.records as record, index (index)}
										<tr class="[&:last-child>td]:border-b-0">
											<td class="border-b border-[var(--ds-border)] px-4 py-2 font-mono text-foreground">{record.type}</td>
											<td class="border-b border-[var(--ds-border)] px-4 py-2 font-mono break-all text-foreground">{record.name}</td>
											<td class="border-b border-[var(--ds-border)] px-4 py-2 font-mono break-all text-foreground">
												{record.priority === undefined ? '' : `${record.priority} `}{record.value}
											</td>
											<td class="border-b border-[var(--ds-border)] px-4 py-2 text-[var(--muted-fg)]">{record.status ?? 'Pending'}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				</section>
			{/each}
		{/if}
	</div>
</PageShell>

<Dialog.Root open={adding} onOpenChange={(value) => !value && busy !== 'add' && (adding = false)}>
	<Dialog.Content class="w-[420px]">
		<Dialog.Header>
			<Dialog.Title>Add domain</Dialog.Title>
			<Dialog.Description>Connect a domain by adding its DNS records. Custom domains require a configured SMTP gateway.</Dialog.Description>
		</Dialog.Header>
		<form class="mt-1 space-y-3" onsubmit={add}>
			<FormField label="Domain" for="new-domain" required>
				<Input id="new-domain" bind:value={newDomain} required placeholder="agents.example.com" autocomplete="off" />
			</FormField>
			{#if addError}<p class="text-[12px] text-[var(--status-danger-fg)]" role="alert">{addError}</p>{/if}
			<Dialog.Footer class="flex-row items-center justify-end gap-2">
				<Button variant="secondary" disabled={busy === 'add'} onclick={() => (adding = false)}>Cancel</Button>
				<Button type="submit" disabled={busy === 'add'}>{busy === 'add' ? 'Adding…' : 'Add domain'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	open={removing !== null}
	title={`Remove ${removing?.domain ?? removing?.domainId ?? 'domain'}?`}
	description="Active inboxes on this domain must be removed first."
	confirmLabel="Remove domain"
	tone="destructive"
	onConfirm={() => {
		const domain = removing;
		removing = null;
		if (domain) void act(domain, 'deleteDomain');
	}}
/>
