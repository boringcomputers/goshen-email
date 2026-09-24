<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils.js';

	let {
		title,
		description,
		variant = 'dashed',
		size = 'md',
		class: className,
		icon,
		actions,
		children
	}: {
		title: string;
		description?: string;
		variant?: 'default' | 'dashed';
		size?: 'sm' | 'md';
		class?: string;
		icon?: Snippet;
		actions?: Snippet;
		children?: Snippet;
	} = $props();
</script>

<div
	class={cn(
		'flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border text-center',
		variant === 'dashed'
			? 'border-dashed border-[var(--ds-border)]'
			: 'border-[var(--ds-border)] bg-[var(--surface)]',
		size === 'md' ? 'p-6' : 'p-4',
		className
	)}
>
	{#if icon}
		<div
			class="flex items-center justify-center rounded-[8px] border border-[var(--ds-border)] bg-[var(--surface-2)] p-1.5 text-[var(--muted-fg)]"
		>
			{@render icon()}
		</div>
	{/if}
	<div class="space-y-1">
		<p class="text-[14px] font-medium tracking-[-0.01em] text-[var(--fg)]">{title}</p>
		{#if children}
			<div class="mx-auto max-w-sm text-[12px] leading-[1.5] text-pretty text-[var(--muted-fg)]">
				{@render children()}
			</div>
		{:else if description}
			<p class="mx-auto max-w-sm text-[12px] leading-[1.5] text-pretty text-[var(--muted-fg)]">
				{description}
			</p>
		{/if}
	</div>
	{#if actions}<div class="flex items-center gap-2">{@render actions()}</div>{/if}
</div>
