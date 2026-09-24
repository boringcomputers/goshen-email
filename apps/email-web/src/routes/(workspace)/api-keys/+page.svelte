<script lang="ts">
	import { goto } from '$app/navigation';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Badge } from '$lib/components/ds/badge';
	import { Button } from '$lib/components/ds/button';
	import { Checkbox } from '$lib/components/ds/checkbox';
	import * as Dialog from '$lib/components/ds/dialog/index.js';
	import { Input } from '$lib/components/ds/input';
	import { ConfirmDialog, FormField, InlineAlert, PageEmptyState } from '$lib/components/ds/patterns';
	import { Select } from '$lib/components/ds/select';
	import { Skeleton } from '$lib/components/ds/skeleton';
	import PageShell from '$lib/components/PageShell.svelte';
	import { shortDate } from '$lib/services/format';
	import type { ApiKey } from '$lib/services/types';
	import { useWorkspace } from '$lib/workspace.svelte';

	const workspace = useWorkspace();

	const scopeOptions = [
		['inboxes:read', 'Read inboxes', true],
		['inboxes:write', 'Create, group, and delete inboxes', false],
		['messages:read', 'Read messages and attachments', true],
		['messages:write', 'Update labels', false],
		['messages:send', 'Send and reply to email', false]
	] as const;

	let keys = $state<ApiKey[] | null>(null);
	let error = $state('');
	let creating = $state(false);
	let name = $state('');
	let scopes = $state<Record<string, boolean>>({});
	let expiresInDays = $state('30');
	let createdKey = $state('');
	let createError = $state('');
	let busy = $state(false);
	let revoking = $state<ApiKey | null>(null);
	let listVersion = 0;

	const status = (key: ApiKey) =>
		key.revokedAt ? 'Revoked' : key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now() ? 'Expired' : 'Active';

	async function load() {
		const version = ++listVersion;
		error = '';
		try {
			const result = await workspace.rpc<{ keys: ApiKey[] }>('listApiKeys');
			if (version === listVersion) keys = result.keys;
		} catch (failure) {
			if (version === listVersion) error = failure instanceof Error ? failure.message : 'API keys could not load.';
		}
	}

	onMount(() => {
		if (!workspace.isCustomer) void goto('/inboxes', { replaceState: true });
		else void load();
	});

	function openCreate() {
		name = createdKey = createError = '';
		scopes = Object.fromEntries(scopeOptions.map(([value, , checked]) => [value, checked]));
		expiresInDays = '30';
		creating = true;
	}

	// The new key is shown once; closing the dialog forgets it.
	function closeCreate() {
		if (busy) return;
		creating = false;
		createdKey = '';
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		busy = true;
		createError = '';
		try {
			const result = await workspace.rpc<{ apiKey: string }>('createApiKey', {
				name: name.trim(),
				scopes: Object.entries(scopes).filter(([, checked]) => checked).map(([scope]) => scope),
				expiresInDays: Number(expiresInDays)
			});
			if (creating) createdKey = result.apiKey;
			await load().catch(() => (error = 'Key created. Reopen API keys to refresh the list.'));
		} catch (failure) {
			createError = failure instanceof Error ? failure.message : 'The key could not be created.';
		} finally {
			busy = false;
		}
	}

	async function copyKey() {
		try {
			await navigator.clipboard.writeText(createdKey);
			toast.success('API key copied');
		} catch {
			createError = 'Clipboard access failed. Select and copy the key manually.';
		}
	}

	async function revoke(key: ApiKey) {
		try {
			await workspace.rpc('revokeApiKey', { keyId: key.keyId });
			toast.success('API key revoked');
			await load();
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'The key could not be revoked.';
		}
	}

	const headClass = 'border-b border-[var(--ds-border)] px-4 py-2.5 text-left text-[11px] font-medium uppercase text-[var(--muted-fg)]';
	const cellClass = 'border-b border-[var(--ds-border)] px-4 py-3';
</script>

<svelte:head>
	<title>API keys · Goshen Email</title>
</svelte:head>

<PageShell title="API keys" description="Connect your agents to every inbox in your account.">
	{#snippet actions()}
		<Button onclick={openCreate}><PlusIcon aria-hidden="true" /> Create API key</Button>
	{/snippet}

	<div class="mt-3 space-y-3">
		{#if error}<InlineAlert tone="danger">{error}</InlineAlert>{/if}
		{#if keys === null && !error}
			<Skeleton class="h-24 w-full" />
		{:else if keys?.length === 0}
			<PageEmptyState title="No account API keys yet." description="Create a key to connect your first agent.">
				{#snippet icon()}<KeyRoundIcon class="size-4" aria-hidden="true" />{/snippet}
				{#snippet actions()}<Button onclick={openCreate}>Create API key</Button>{/snippet}
			</PageEmptyState>
		{:else if keys}
			<div class="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)]">
				<table class="w-full border-collapse text-[13px]">
					<thead>
						<tr>
							<th scope="col" class={headClass}>Name</th>
							<th scope="col" class={headClass}>Key</th>
							<th scope="col" class={headClass}>Status</th>
							<th scope="col" class={headClass}>Expires</th>
							<th scope="col" class={headClass}><span class="sr-only">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each keys as key (key.keyId)}
							{@const state = status(key)}
							<tr class="[&:last-child>td]:border-b-0">
								<td class={cellClass}>
									<span class="block font-medium text-foreground">{key.name}</span>
									<span class="block text-[12px] text-[var(--muted-fg)]">{key.scopes.join(', ')}</span>
								</td>
								<td class={cellClass}><code class="font-mono text-[12px] text-foreground">{key.prefix}…</code></td>
								<td class={cellClass}>
									<Badge variant={state === 'Active' ? 'emerald' : 'secondary'} size="sm">{state}</Badge>
								</td>
								<td class="{cellClass} text-[var(--muted-fg)] tabular-nums">{key.expiresAt ? shortDate(key.expiresAt) : 'Never'}</td>
								<td class="{cellClass} text-right">
									{#if state === 'Active'}
										<Button size="sm" variant="ghost" aria-label={`Revoke ${key.name}`} onclick={() => (revoking = key)}>Revoke</Button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</PageShell>

<Dialog.Root open={creating} onOpenChange={(value) => !value && closeCreate()}>
	<Dialog.Content class="w-[440px]">
		<Dialog.Header>
			<Dialog.Title>Create API key</Dialog.Title>
			<Dialog.Description>Choose what this key can access. It can be used across all your inboxes.</Dialog.Description>
		</Dialog.Header>
		{#if createdKey}
			<p class="text-[13px] text-[var(--muted-fg)]">
				Copy this key now. It is shown only once. Store it as <code class="font-mono text-[12px] text-foreground">BEZALEL_API_KEY</code>.
			</p>
			<FormField label="New account API key" for="new-api-key">
				<Input id="new-api-key" type="password" value={createdKey} readonly autocomplete="off" />
			</FormField>
			<Dialog.Footer class="flex-row items-center justify-end gap-2">
				<Button variant="secondary" onclick={closeCreate}>Done</Button>
				<Button onclick={copyKey}>Copy API key</Button>
			</Dialog.Footer>
		{:else}
			<form class="mt-1 space-y-3" onsubmit={create}>
				<FormField label="Key name" for="key-name" required>
					<Input id="key-name" bind:value={name} required maxlength={100} placeholder="Research agent" autocomplete="off" />
				</FormField>
				<fieldset class="space-y-2">
					<legend class="mb-1.5 text-[12px] font-medium uppercase tracking-[0.01em] text-[var(--muted-fg)]">Permissions</legend>
					{#each scopeOptions as [value, label] (value)}
						<div><Checkbox bind:checked={scopes[value]} {label} /></div>
					{/each}
				</fieldset>
				<FormField label="Expires after" for="key-expiry">
					<Select
						id="key-expiry"
						bind:value={expiresInDays}
						options={[
							{ value: '30', label: '30 days' },
							{ value: '90', label: '90 days' },
							{ value: '365', label: '1 year' }
						]}
					/>
				</FormField>
				{#if createError}<p class="text-[12px] text-[var(--status-danger-fg)]" role="alert">{createError}</p>{/if}
				<Dialog.Footer class="flex-row items-center justify-end gap-2">
					<Button variant="secondary" disabled={busy} onclick={closeCreate}>Cancel</Button>
					<Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create API key'}</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	open={revoking !== null}
	title={`Revoke ${revoking?.name ?? 'this key'}?`}
	description="Any agent using it will lose access immediately."
	confirmLabel="Revoke key"
	tone="destructive"
	onConfirm={() => {
		const key = revoking;
		revoking = null;
		if (key) void revoke(key);
	}}
/>
