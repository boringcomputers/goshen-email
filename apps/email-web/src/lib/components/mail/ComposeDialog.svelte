<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ds/button';
	import * as Dialog from '$lib/components/ds/dialog/index.js';
	import { Input } from '$lib/components/ds/input';
	import { ConfirmDialog, FormField, InlineAlert } from '$lib/components/ds/patterns';
	import { Textarea } from '$lib/components/ds/textarea';
	import { draftPayload, newDraft, type Draft } from '$lib/services/mail';
	import { useWorkspace } from '$lib/workspace.svelte';
	import AttachmentPicker from './AttachmentPicker.svelte';

	const workspace = useWorkspace();

	let draft = $state<Draft | null>(null);
	let to = $state('');
	let subject = $state('');
	let text = $state('');
	let files = $state<File[]>([]);
	let sending = $state(false);
	let error = $state('');
	let confirmDiscard = $state(false);

	const open = $derived(workspace.composeFor !== null);
	const frozen = $derived(Boolean(draft?.payload));
	// A draft whose send was attempted stays with its inbox, so a retry repeats the same request.
	const stale = $derived(Boolean(draft && workspace.composeFor && draft.inboxId !== workspace.composeFor && draft.payload));

	// Reopening compose returns to the closed draft. A draft that was never sent moves to the inbox
	// compose was opened from, keeping what was typed.
	$effect(() => {
		const target = workspace.composeFor;
		if (!target) return;
		untrack(() => {
			if (!draft || (draft.inboxId !== target && !draft.payload)) {
				draft = newDraft(target);
				error = '';
			}
		});
	});

	function clear() {
		draft = null;
		to = subject = text = error = '';
		files = [];
	}

	function close() {
		if (!sending) workspace.composeFor = null;
	}

	function discard() {
		if (draft?.payload) confirmDiscard = true;
		else {
			clear();
			close();
		}
	}

	// Discarding another inbox's pending send leaves compose open on a fresh draft for this inbox.
	function discardConfirmed() {
		const target = stale ? workspace.composeFor : null;
		clear();
		if (target) draft = newDraft(target);
		else close();
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const current = draft;
		if (!current || sending) return;
		sending = true;
		error = '';
		try {
			current.payload ??= await draftPayload(current, { to, subject, text, files });
			await workspace.rpc('send', current.payload);
			clear();
			workspace.composeFor = null;
			workspace.mailVersion++;
			toast.success('Message accepted for sending');
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'The message could not be sent.';
		} finally {
			sending = false;
		}
	}
</script>

<Dialog.Root {open} onOpenChange={(value) => !value && close()}>
	<Dialog.Content
		class="w-[520px]"
		escapeKeydownBehavior={sending ? 'ignore' : 'close'}
		interactOutsideBehavior={sending ? 'ignore' : 'close'}
	>
		<Dialog.Header>
			<Dialog.Title>New message</Dialog.Title>
			<Dialog.Description>From: {draft?.inboxId ?? workspace.composeFor}</Dialog.Description>
		</Dialog.Header>
		{#if stale}
			<InlineAlert tone="warning" title={`This draft belongs to ${draft?.inboxId}`}>
				Its last send may already have been accepted. Retry it from that inbox, or discard it to write from
				{workspace.composeFor}.
			</InlineAlert>
		{/if}
		<form class="mt-1 space-y-3" onsubmit={submit}>
			<FormField label="To" for="compose-to">
				<Input id="compose-to" bind:value={to} placeholder="name@example.com" required disabled={frozen} autocomplete="off" />
			</FormField>
			<FormField label="Subject" for="compose-subject">
				<Input id="compose-subject" bind:value={subject} maxlength={998} placeholder="Add a subject" disabled={frozen} autocomplete="off" />
			</FormField>
			<FormField label="Message" for="compose-text">
				<Textarea id="compose-text" bind:value={text} rows={8} placeholder="Write your message…" required disabled={frozen} />
			</FormField>
			<AttachmentPicker bind:files disabled={frozen} />
			{#if error}<p class="text-[12px] text-[var(--status-danger-fg)]" role="alert">{error}</p>{/if}
			<Dialog.Footer class="flex-row items-center justify-end gap-2">
				<Button variant="secondary" disabled={sending} onclick={discard}>Discard draft</Button>
				<Button type="submit" disabled={sending}>
					{sending ? 'Sending…' : frozen ? 'Retry same request' : 'Send message'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmDiscard}
	title="Discard this request?"
	description="A send without a confirmed receipt may already have been accepted."
	confirmLabel="Discard"
	tone="destructive"
	onConfirm={discardConfirmed}
/>
