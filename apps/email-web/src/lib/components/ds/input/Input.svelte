<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils.js';

	let {
		value = $bindable(),
		type = 'text',
		class: className,
		...rest
	}: HTMLInputAttributes = $props();
</script>

<input
	bind:value
	{type}
	class={cn(
		'w-full rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)] px-3.5 py-2.5 text-[13px] text-[var(--fg)] outline-none placeholder:text-[var(--muted-fg)] focus:border-[var(--accent-text)] disabled:opacity-50',
		className
	)}
	{...rest}
/>
