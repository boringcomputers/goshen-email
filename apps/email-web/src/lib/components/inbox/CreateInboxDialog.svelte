<script lang="ts">
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ds/button';
	import * as Dialog from '$lib/components/ds/dialog/index.js';
	import { Input } from '$lib/components/ds/input';
	import { FormField } from '$lib/components/ds/patterns';
	import { useWorkspace } from '$lib/workspace.svelte';

	const workspace = useWorkspace();

	let displayName = $state('');
	let username = $state('');
	let domain = $state('');
	let busy = $state(false);
	let error = $state('');

	// Customer accounts create inboxes on the service's default domain only.
	const fixedDomain = $derived(workspace.isCustomer ? (workspace.session?.defaultDomain ?? '') : '');

	$effect(() => {
		if (workspace.creatingInbox) {
			displayName = username = error = '';
			domain = fixedDomain;
		}
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		busy = true;
		error = '';
		try {
			const input = Object.fromEntries(
				Object.entries({ displayName, username, domain }).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value)
			);
			const result = await workspace.createInbox(input);
			workspace.creatingInbox = false;
			toast.success('Inbox created');
			await goto(`/inboxes/${encodeURIComponent(result.inboxId)}`);
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'The inbox could not be created.';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root open={workspace.creatingInbox} onOpenChange={(value) => !value && !busy && (workspace.creatingInbox = false)}>
	<Dialog.Content class="w-[400px]">
		<Dialog.Header>
			<Dialog.Title>Create an inbox</Dialog.Title>
			<Dialog.Description>A dedicated address for your next conversation.</Dialog.Description>
		</Dialog.Header>
		<form class="mt-1 space-y-3" onsubmit={submit}>
			<FormField label="Name" for="inbox-name">
				<Input id="inbox-name" bind:value={displayName} maxlength={200} placeholder="Research assistant" autocomplete="off" />
			</FormField>
			<FormField label="Username" for="inbox-username" required>
				<Input
					id="inbox-username"
					bind:value={username}
					required
					maxlength={64}
					pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]*"
					placeholder="research"
					autocomplete="off"
					autocapitalize="none"
					spellcheck={false}
				/>
			</FormField>
			<FormField label="Domain" for="inbox-domain" hint={fixedDomain ? 'Inboxes use your workspace domain.' : 'Leave blank for the default domain.'}>
				<Input id="inbox-domain" bind:value={domain} readonly={Boolean(fixedDomain)} placeholder="Default domain" autocomplete="off" />
			</FormField>
			{#if error}<p class="text-[12px] text-[var(--status-danger-fg)]" role="alert">{error}</p>{/if}
			<Dialog.Footer class="flex-row items-center justify-end gap-2">
				<Button variant="secondary" disabled={busy} onclick={() => (workspace.creatingInbox = false)}>Cancel</Button>
				<Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create inbox'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
