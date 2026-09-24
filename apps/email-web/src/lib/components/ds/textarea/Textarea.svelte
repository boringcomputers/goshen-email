<script lang="ts">
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils.js';

	let {
		value = $bindable(),
		mono = false,
		class: className,
		...rest
	}: HTMLTextareaAttributes & { mono?: boolean } = $props();
</script>

<textarea
	bind:value
	class={cn(
		'min-h-16 w-full resize-y rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)] px-3.5 py-2.5 text-[13px] leading-[1.5] text-[var(--fg)] outline-none placeholder:text-[var(--muted-fg)] focus:border-[var(--accent-text)] disabled:opacity-50',
		mono && 'font-mono text-[12px]',
		className
	)}
	{...rest}
></textarea>
