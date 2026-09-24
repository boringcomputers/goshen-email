<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils.js';

	let {
		as = 'span',
		class: className,
		children
	}: { as?: 'span' | 'h2'; class?: string; children?: Snippet } = $props();

	const base = 'block text-[12px] font-medium uppercase tracking-[0.01em] text-[var(--muted-fg)]';
</script>

{#if as === 'h2'}
	<h2 class={cn(base, className)}>{@render children?.()}</h2>
{:else}
	<span class={cn(base, className)}>{@render children?.()}</span>
{/if}
