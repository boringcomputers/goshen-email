<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		label,
		for: htmlFor,
		description,
		error,
		hint,
		required = false,
		children
	}: {
		label: string;
		for?: string;
		description?: string;
		error?: string;
		hint?: string;
		required?: boolean;
		children?: Snippet;
	} = $props();
</script>

<div class="space-y-1.5">
	<label
		for={htmlFor}
		class="block text-[12px] font-medium uppercase tracking-[0.01em] text-[var(--muted-fg)]"
	>
		{label}{#if required}<span class="ml-0.5 text-[oklch(0.58_0.19_27)]">*</span>{/if}
	</label>
	{#if description}<p class="text-[12px] leading-[1.5] text-[var(--muted-fg)]">{description}</p>{/if}
	{@render children?.()}
	{#if error}
		<p class="text-[12px] text-[oklch(0.58_0.19_27)]">{error}</p>
	{:else if hint}
		<p class="text-[12px] text-[var(--muted-fg)]">{hint}</p>
	{/if}
</div>
