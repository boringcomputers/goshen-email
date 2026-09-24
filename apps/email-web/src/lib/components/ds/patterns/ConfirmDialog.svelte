<script lang="ts">
	import * as Dialog from '$lib/components/ds/dialog/index.js';
	import { Button } from '$lib/components/ds/button/index.js';

	let {
		open = $bindable(false),
		title,
		description,
		confirmLabel = 'Confirm',
		cancelLabel = 'Cancel',
		tone = 'default',
		onConfirm
	}: {
		open?: boolean;
		title: string;
		description?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		tone?: 'default' | 'destructive';
		onConfirm: () => void;
	} = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="p-5" showCloseButton={false}>
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			{#if description}<Dialog.Description>{description}</Dialog.Description>{/if}
		</Dialog.Header>
		<Dialog.Footer class="mt-1.5 flex-row items-center justify-end gap-2">
			<Button variant="secondary" onclick={() => (open = false)}>{cancelLabel}</Button>
			<Button
				variant={tone === 'destructive' ? 'destructive' : 'default'}
				onclick={() => {
					// Close even when onConfirm throws synchronously so the dialog
					// never gets stuck open.
					try {
						onConfirm();
					} finally {
						open = false;
					}
				}}
			>
				{confirmLabel}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
