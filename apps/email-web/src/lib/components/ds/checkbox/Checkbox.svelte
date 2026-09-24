<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils.js';

	let {
		checked = $bindable(false),
		label,
		class: className,
		...rest
	}: HTMLInputAttributes & { label?: string } = $props();
</script>

<label class="inline-flex items-center gap-2 text-[13px] text-foreground">
	<input
		type="checkbox"
		bind:checked
		class={cn(
			'size-4 shrink-0 appearance-none rounded-[var(--radius-inner)] border border-[var(--ds-border)] bg-[var(--surface)] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40 checked:border-transparent checked:bg-[var(--accent)] checked:bg-center checked:bg-no-repeat checked:text-[var(--accent-fg)] checked:[background-image:url(data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%2210%22%20height=%2210%22%20viewBox=%220%200%2010%2010%22%3E%3Cpath%20d=%22M1.5%205.5l2.5%202.5%204.5-6%22%20fill=%22none%22%20stroke=%22%23fff%22%20stroke-width=%221.8%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22/%3E%3C/svg%3E)] disabled:opacity-50',
			className
		)}
		{...rest}
	/>
	{#if label}<span>{label}</span>{/if}
</label>
