<script lang="ts" module>
	export type Tab = { key: string; label: string; count?: number; panelId?: string };
</script>

<script lang="ts">
	import { cn } from '$lib/utils.js';

	let {
		tabs,
		active,
		onChange,
		variant = 'underline',
		class: className
	}: {
		tabs: Tab[];
		active: string;
		onChange: (key: string) => void;
		variant?: 'underline' | 'segmented';
		class?: string;
	} = $props();
</script>

{#if variant === 'segmented'}
	<div
		class={cn(
			'inline-flex w-fit gap-1 rounded-[var(--radius-pill)] border border-[var(--ds-border)] bg-[var(--surface)] p-1',
			className
		)}
		role="tablist"
	>
		{#each tabs as tab (tab.key)}
			<button
				type="button"
				role="tab"
				id={`${tab.key}-tab`}
				aria-selected={active === tab.key}
				aria-controls={tab.panelId}
				onclick={() => onChange(tab.key)}
				class={cn(
					'rounded-[var(--radius-pill)] px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-150',
					active === tab.key
						? 'bg-[var(--active)] text-[var(--fg)]'
						: 'text-[var(--muted-fg)] hover:text-[var(--fg)]'
				)}
			>
				{tab.label}{#if tab.count !== undefined}<span class="ml-1 text-[11px] tabular-nums text-[var(--subtle)]"
						>{tab.count}</span
					>{/if}
			</button>
		{/each}
	</div>
{:else}
	<div
		class={cn(
			'inline-flex w-fit gap-1 rounded-[var(--radius-pill)] border border-[var(--ds-border)] bg-[var(--surface)] p-1',
			className
		)}
		role="tablist"
	>
		{#each tabs as tab (tab.key)}
			<button
				type="button"
				role="tab"
				id={`${tab.key}-tab`}
				aria-selected={active === tab.key}
				aria-controls={tab.panelId}
				onclick={() => onChange(tab.key)}
				class={cn(
					'rounded-[var(--radius-pill)] px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-150',
					active === tab.key
						? 'bg-[var(--active)] text-[var(--fg)]'
						: 'text-[var(--muted-fg)] hover:text-[var(--fg)]'
				)}
			>
				{tab.label}{#if tab.count !== undefined}<span class="ml-1 text-[11px] tabular-nums text-[var(--subtle)]"
						>{tab.count}</span
					>{/if}
			</button>
		{/each}
	</div>
{/if}
