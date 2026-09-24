<script lang="ts">
	import type { Snippet } from 'svelte';
	import SectionLabel from './SectionLabel.svelte';

	let {
		title,
		description,
		eyebrow,
		actions
	}: {
		title: string;
		description?: string;
		eyebrow?: string;
		actions?: Snippet;
	} = $props();
</script>

<div class="flex items-start justify-between gap-4">
	<div class="min-w-0">
		{#if eyebrow}<SectionLabel class="mb-1">{eyebrow}</SectionLabel>{/if}
		<h2 class="text-[14px] font-medium tracking-[-0.01em] text-balance text-[var(--fg)]">{title}</h2>
		{#if description}
			<p class="mt-0.5 text-[13px] tracking-[-0.02em] text-pretty text-[var(--muted-fg)]">{description}</p>
		{/if}
	</div>
	{#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
</div>
