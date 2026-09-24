<script lang="ts">
	import { cn } from '$lib/utils.js';

	let {
		label,
		description,
		checked = $bindable(false),
		disabled = false,
		onchange,
		class: className
	}: {
		label: string;
		description?: string;
		checked?: boolean;
		disabled?: boolean;
		onchange?: (value: boolean) => void;
		class?: string;
	} = $props();

	function handle(e: Event) {
		const value = (e.currentTarget as HTMLInputElement).checked;
		checked = value;
		onchange?.(value);
	}
</script>

<label
	class={cn(
		'flex items-center justify-between gap-4 rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)] px-3 py-2.5',
		disabled && 'opacity-60',
		className
	)}
>
	<div class="min-w-0">
		<p class="text-[13px] font-medium text-foreground">{label}</p>
		{#if description}<p class="mt-0.5 text-[12px] text-[var(--muted-fg)]">{description}</p>{/if}
	</div>
	<span class="relative inline-flex shrink-0">
		<input
			type="checkbox"
			bind:checked
			{disabled}
			onchange={handle}
			class="peer h-5 w-9 appearance-none rounded-[var(--radius-pill)] border border-[var(--ds-border)] bg-[var(--surface)] p-0.5 outline-none transition-colors duration-150 checked:border-transparent checked:bg-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
		/>
		<span
			aria-hidden="true"
			class="pointer-events-none absolute top-[3px] left-[3px] size-3.5 rounded-full bg-[var(--muted-fg)] transition-transform duration-150 peer-checked:translate-x-4 peer-checked:bg-[var(--accent-fg)]"
		></span>
	</span>
</label>
