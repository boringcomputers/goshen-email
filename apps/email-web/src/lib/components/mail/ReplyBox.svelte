<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ds/button';
	import { ConfirmDialog } from '$lib/components/ds/patterns';
	import { Textarea } from '$lib/components/ds/textarea';
	import { draftPayload, newDraft, type Draft } from '$lib/services/mail';
	import type { Message } from '$lib/services/types';
	import { useWorkspace } from '$lib/workspace.svelte';
	import AttachmentPicker from './AttachmentPicker.svelte';

	let { inboxId, message, onSent }: { inboxId: string; message: Message; onSent: () => Promise<void> } = $props();

	const workspace = useWorkspace();

	// The parent keys this component by message, so each conversation gets its own idempotency key.
	const startDraft = () => newDraft(inboxId, message);

	let draft = $state<Draft>(startDraft());
	let text = $state('');
	let files = $state<File[]>([]);
	let sending = $state(false);
	let error = $state('');
	let confirmDiscard = $state(false);

	const frozen = $derived(Boolean(draft.payload));

	function reset() {
		draft = startDraft();
		text = error = '';
		files = [];
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const current = draft;
		if (sending || !text.trim()) return;
		sending = true;
		error = '';
		try {
			current.payload ??= await draftPayload(current, { text, files });
			await workspace.rpc('reply', current.payload);
			reset();
			toast.success('Reply accepted for sending');
			await onSent();
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'The reply could not be sent.';
		} finally {
			sending = false;
		}
	}
</script>

<form class="border-t border-[var(--border-color)] p-4" onsubmit={submit} aria-label="Reply">
	<label class="mb-2 block text-[12px] text-[var(--muted-fg)]" for="reply-body">
		<span class="font-medium uppercase tracking-[0.01em]">Reply</span> to {message.from}
	</label>
	<Textarea id="reply-body" bind:value={text} rows={4} placeholder="Write a reply…" disabled={frozen} />
	{#if error}<p class="mt-2 text-[12px] text-[var(--status-danger-fg)]" role="alert">{error}</p>{/if}
	<div class="mt-2 flex flex-wrap items-center justify-between gap-2">
		<AttachmentPicker bind:files disabled={frozen} />
		<div class="flex items-center gap-2">
			{#if frozen}
				<Button variant="secondary" disabled={sending} onclick={() => (confirmDiscard = true)}>Discard</Button>
			{/if}
			<Button type="submit" disabled={sending || !text.trim()}>
				{sending ? 'Sending…' : frozen ? 'Retry same request' : 'Send reply'}
			</Button>
		</div>
	</div>
</form>

<ConfirmDialog
	bind:open={confirmDiscard}
	title="Discard this reply?"
	description="A send without a confirmed receipt may already have been accepted."
	confirmLabel="Discard"
	tone="destructive"
	onConfirm={reset}
/>
