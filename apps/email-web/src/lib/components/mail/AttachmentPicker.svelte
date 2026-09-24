<script lang="ts">
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ds/button';

	let { files = $bindable<File[]>([]), disabled = false }: { files?: File[]; disabled?: boolean } = $props();

	let input = $state<HTMLInputElement | null>(null);

	function add(event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		files = [...files, ...(target.files ?? [])];
		target.value = '';
	}
</script>

<div class="flex min-w-0 flex-wrap items-center gap-1.5">
	<input bind:this={input} type="file" multiple class="hidden" {disabled} onchange={add} aria-label="Attachments" />
	<Button variant="ghost" size="sm" {disabled} onclick={() => input?.click()}>
		<PaperclipIcon class="size-3.5" aria-hidden="true" />
		Attach files
	</Button>
	{#each files as file, index (index)}
		<span class="inline-flex max-w-[200px] items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--ds-border)] bg-[var(--surface)] py-0.5 pr-1 pl-2.5 text-[12px] text-foreground">
			<span class="truncate">{file.name}</span>
			<span class="shrink-0 text-[var(--muted-fg)]">{Math.ceil(file.size / 1024)} KB</span>
			<button
				type="button"
				class="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[var(--muted-fg)] hover:text-foreground disabled:opacity-50"
				aria-label={`Remove ${file.name}`}
				{disabled}
				onclick={() => (files = files.filter((_, position) => position !== index))}
			>
				<XIcon class="size-3" aria-hidden="true" />
			</button>
		</span>
	{:else}
		<span class="text-[12px] text-[var(--muted-fg)]">Up to 2 MiB total</span>
	{/each}
</div>
