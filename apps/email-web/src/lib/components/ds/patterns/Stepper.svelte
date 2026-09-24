<script lang="ts">
	import { cn } from '$lib/utils.js';

	let {
		steps,
		current = $bindable(0),
		clickable = false,
		onstep,
		size = 'md',
		class: className
	}: {
		steps: ({ label: string } | string)[];
		current?: number;
		clickable?: boolean;
		onstep?: (i: number) => void;
		size?: 'sm' | 'md';
		class?: string;
	} = $props();

	const items = $derived(steps.map((s) => (typeof s === 'string' ? { label: s } : s)));

	function circleCls(i: number): string {
		const base =
			size === 'md'
				? 'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium'
				: 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium';
		if (i < current) return cn(base, 'bg-[var(--accent)] text-[var(--accent-fg)]');
		if (i === current) {
			return size === 'md'
				? cn(base, 'bg-[var(--accent)] text-[var(--accent-fg)] ring-2 ring-[var(--accent)]/20')
				: cn(base, 'border border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--fg)]');
		}
		return cn(base, 'bg-[var(--surface-2)] text-[var(--muted-fg)]');
	}

	function goTo(i: number) {
		if (!clickable || i > current) return;
		current = i;
		onstep?.(i);
	}
</script>

{#snippet circleContent(i: number)}
	{#if i < current}
		<svg
			class={size === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3'}
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			stroke-width="2.5"
			aria-hidden="true"
		>
			<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
		</svg>
	{:else}
		{i + 1}
	{/if}
{/snippet}

{#if size === 'md'}
	<div class={cn('flex items-start', className)}>
		{#each items as step, i (i)}
			<div class="flex min-w-0 flex-1 flex-col items-center">
				<div class="flex w-full items-center">
					{#if i === 0}
						<div class="flex-1"></div>
					{:else}
						<div
							class="h-px flex-1 {i <= current ? 'bg-[var(--accent)]' : 'bg-[var(--ds-border)]'}"
						></div>
					{/if}
					{#if clickable && i <= current}
						<button
							type="button"
							class={circleCls(i)}
							aria-current={i === current ? 'step' : undefined}
							onclick={() => goTo(i)}
						>
							{@render circleContent(i)}
						</button>
					{:else}
						<div class={circleCls(i)} aria-current={i === current ? 'step' : undefined}>
							{@render circleContent(i)}
						</div>
					{/if}
					{#if i === items.length - 1}
						<div class="flex-1"></div>
					{:else}
						<div
							class="h-px flex-1 {i < current ? 'bg-[var(--accent)]' : 'bg-[var(--ds-border)]'}"
						></div>
					{/if}
				</div>
				<span
					class="mt-1.5 truncate text-center text-[12px] {i === current
						? 'text-[var(--fg)]'
						: 'text-[var(--muted-fg)]'}"
				>
					{step.label}
				</span>
			</div>
		{/each}
	</div>
{:else}
	<div class={cn('flex items-center gap-1.5', className)}>
		{#each items as step, i (i)}
			{#if i > 0}
				<span
					class="h-px flex-1 {i <= current ? 'bg-[var(--accent)]' : 'bg-[var(--ds-border)]'}"
					aria-hidden="true"
				></span>
			{/if}
			{#if clickable && i <= current}
				<button
					type="button"
					class="flex min-w-0 shrink-0 items-center gap-1.5"
					aria-current={i === current ? 'step' : undefined}
					onclick={() => goTo(i)}
				>
					<span class={circleCls(i)}>{@render circleContent(i)}</span>
					<span
						class="truncate text-[12px] {i === current
							? 'text-[var(--fg)]'
							: 'text-[var(--muted-fg)]'}"
					>
						{step.label}
					</span>
				</button>
			{:else}
				<span
					class="flex min-w-0 shrink-0 items-center gap-1.5"
					aria-current={i === current ? 'step' : undefined}
				>
					<span class={circleCls(i)}>{@render circleContent(i)}</span>
					<span
						class="truncate text-[12px] {i === current
							? 'text-[var(--fg)]'
							: 'text-[var(--muted-fg)]'}"
					>
						{step.label}
					</span>
				</span>
			{/if}
		{/each}
	</div>
{/if}
