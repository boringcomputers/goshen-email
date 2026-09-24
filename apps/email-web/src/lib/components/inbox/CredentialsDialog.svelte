<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ds/button';
	import * as Dialog from '$lib/components/ds/dialog/index.js';
	import { Input } from '$lib/components/ds/input';
	import { ConfirmDialog, FormField } from '$lib/components/ds/patterns';
	import { connectionCommand } from '$lib/services/mail';
	import type { SetupStatus } from '$lib/services/types';
	import { useWorkspace } from '$lib/workspace.svelte';

	const workspace = useWorkspace();

	let apiKey = $state('');
	let status = $state('');
	let error = $state('');
	let confirmRotate = $state(false);
	let busy = $state(false);

	const inboxId = $derived(workspace.credentialsFor);
	const apiUrl = $derived(workspace.session?.apiUrl);
	const command = $derived(apiUrl ? connectionCommand(apiUrl) : '');

	async function load(operation: 'getCredentials' | 'rotateCredentials') {
		const target = inboxId;
		if (!target) return;
		const result = await workspace.rpc<{ inboxId: string; apiKey: string }>(operation, { inboxId: target });
		// The key belongs to the inbox this dialog was opened for, or it is dropped.
		if (workspace.credentialsFor === target && result.inboxId === target) apiKey = result.apiKey;
	}

	$effect(() => {
		apiKey = '';
		error = '';
		status = 'Run the command, then check the connection.';
		if (inboxId) load('getCredentials').catch((failure) => (error = failure.message));
	});

	async function copy(value: string, message: string) {
		try {
			await navigator.clipboard.writeText(value);
			toast.success(message);
		} catch {
			error = 'Clipboard access failed. Select and copy the text manually.';
		}
	}

	async function checkConnection() {
		const target = inboxId;
		if (!target || busy) return;
		busy = true;
		try {
			const result = await workspace.rpc<SetupStatus>('setupStatus', { inboxId: target });
			if (workspace.credentialsFor !== target) return;
			status = result.connectedAt
				? 'Connected. This API key can access your inbox.'
				: 'No connection yet. Run the command with the current API key, then check again.';
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'The connection check failed.';
		} finally {
			busy = false;
		}
	}

	async function rotate() {
		busy = true;
		error = '';
		try {
			await load('rotateCredentials');
			status = 'Key replaced. Update your agent and run the command again.';
			toast.success('Mailbox key replaced');
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'The key could not be replaced.';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root open={inboxId !== null} onOpenChange={(value) => !value && (workspace.credentialsFor = null)}>
	<Dialog.Content class="w-[480px]">
		<Dialog.Header>
			<Dialog.Title>Mailbox API key</Dialog.Title>
			<Dialog.Description>{inboxId}</Dialog.Description>
		</Dialog.Header>
		<p class="text-[12px] text-[var(--muted-fg)]">This key gives an agent access to this mailbox. Keep it private.</p>
		<FormField label="API key" for="mailbox-key">
			<Input id="mailbox-key" type="password" value={apiKey} readonly autocomplete="off" placeholder="Loading…" />
		</FormField>
		{#if command}
			<section class="space-y-2 rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)] p-3.5">
				<h3 class="text-[13px] font-medium text-foreground">Connect your agent</h3>
				<p class="text-[12px] leading-[1.5] text-[var(--muted-fg)]">
					Save this key as <code class="font-mono text-[11px] text-foreground">GOSHENEMAIL_MAILBOX_KEY</code> in your agent's environment.
					Run this command there to check access. It returns the inbox address and does not send email.
				</p>
				<pre
					class="overflow-x-auto rounded-[var(--radius-inner)] bg-[var(--surface-2)] p-2.5 font-mono text-[11px] leading-[1.6] text-foreground"
					aria-label="Mailbox connection command">{command}</pre>
				<div class="flex flex-wrap items-center gap-2">
					<Button size="sm" variant="secondary" onclick={() => copy(command, 'Command copied')}>Copy command</Button>
					<Button size="sm" variant="secondary" disabled={busy} onclick={checkConnection}>Check connection</Button>
					<p class="text-[12px] text-[var(--muted-fg)]" role="status">{status}</p>
				</div>
			</section>
		{/if}
		{#if error}<p class="text-[12px] text-[var(--status-danger-fg)]" role="alert">{error}</p>{/if}
		<Dialog.Footer class="flex-row items-center justify-end gap-2">
			<Button variant="secondary" disabled={busy || !apiKey} onclick={() => (confirmRotate = true)}>Replace key</Button>
			<Button disabled={!apiKey} onclick={() => copy(apiKey, 'Key copied')}>Copy key</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmRotate}
	title="Replace this mailbox key?"
	description="Agents using the old key will lose access."
	confirmLabel="Replace key"
	tone="destructive"
	onConfirm={() => void rotate()}
/>
