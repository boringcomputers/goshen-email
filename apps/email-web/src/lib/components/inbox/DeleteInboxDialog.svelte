<script lang="ts">
	import { goto } from '$app/navigation';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ds/button';
	import * as Dialog from '$lib/components/ds/dialog/index.js';
	import { useWorkspace } from '$lib/workspace.svelte';

	const workspace = useWorkspace();

	let busy = $state(false);
	let error = $state('');
	const target = $derived(workspace.deleting);

	$effect(() => {
		if (target) error = '';
	});

	async function confirm() {
		const inbox = target;
		if (!inbox || busy) return;
		busy = true;
		error = '';
		try {
			await workspace.rpc('deleteInbox', { inboxId: inbox.inboxId });
			// Remove the confirmed deletion locally even if refreshing the inventory fails.
			workspace.removeInbox(inbox.inboxId);
			workspace.deleting = null;
			toast.success('Inbox deleted');
			await goto('/inboxes', { replaceState: true });
			await workspace.loadInboxes().catch(() => toast.error('Inbox deleted. Refresh to load the latest inbox list.'));
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'The inbox could not be deleted.';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root open={target !== null} onOpenChange={(value) => !value && !busy && (workspace.deleting = null)}>
	<Dialog.Content
		class="w-[380px]"
		showCloseButton={false}
		escapeKeydownBehavior={busy ? 'ignore' : 'close'}
		interactOutsideBehavior={busy ? 'ignore' : 'close'}
	>
		<Dialog.Header>
			<Dialog.Title>Delete inbox?</Dialog.Title>
			<Dialog.Description>
				All messages in this inbox will be permanently deleted. This email address cannot be used again.
			</Dialog.Description>
		</Dialog.Header>
		{#if target}
			<div class="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)] px-3.5 py-2.5">
				<InboxIcon class="size-4 shrink-0 text-[var(--muted-fg)]" aria-hidden="true" />
				<div class="min-w-0">
					<p class="truncate text-[13px] font-medium text-foreground">{target.displayName || 'Inbox'}</p>
					<p class="truncate text-[12px] text-[var(--muted-fg)]">{target.address || target.inboxId}</p>
				</div>
			</div>
		{/if}
		{#if error}<p class="text-[12px] text-[var(--status-danger-fg)]" role="alert">{error}</p>{/if}
		<Dialog.Footer class="flex-row items-center justify-end gap-2">
			<Button variant="secondary" disabled={busy} onclick={() => (workspace.deleting = null)}>Cancel</Button>
			<Button variant="destructive" disabled={busy} onclick={confirm}>{busy ? 'Deleting…' : 'Delete inbox'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
