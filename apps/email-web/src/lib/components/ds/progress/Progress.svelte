<script lang="ts">
	import { cn } from '$lib/utils.js';

	let {
		value = 0,
		label,
		class: className
	}: {
		/** Progress from 0 to 100. */
		value?: number;
		/** Accessible label for the progress bar. */
		label?: string;
		class?: string;
	} = $props();

	const pct = $derived(Math.min(100, Math.max(0, value)));
</script>

<div
	role="progressbar"
	aria-label={label}
	aria-valuemin={0}
	aria-valuemax={100}
	aria-valuenow={pct}
	class={cn(
		'h-[6px] w-full overflow-hidden rounded-[var(--radius-inner)] border border-[var(--ds-border)] bg-[var(--surface)]',
		className
	)}
>
	<div
		class="h-full rounded-[var(--radius-inner)] bg-[var(--accent)] [transition:width_300ms_ease]"
		style="width:{pct}%"
	></div>
</div>
