<script lang="ts" module>
	export type AlertTone = 'danger' | 'success' | 'warning' | 'info' | 'neutral';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils.js';

	let {
		tone = 'neutral',
		title,
		dismissible = false,
		onDismiss,
		class: className,
		children,
		actions
	}: {
		tone?: AlertTone;
		title?: string;
		dismissible?: boolean;
		onDismiss?: () => void;
		class?: string;
		children?: Snippet;
		actions?: Snippet;
	} = $props();

	// Self-hide on dismiss so the ✕ always does something, even when the
	// consumer doesn't pass onDismiss (which would otherwise be a dead button).
	let dismissed = $state(false);
	function handleDismiss() {
		dismissed = true;
		onDismiss?.();
	}

	const toneClass: Record<AlertTone, string> = {
		danger: 'border-[oklch(0.58_0.19_27)] text-[oklch(0.58_0.19_27)]',
		success: 'text-[var(--status-success-fg)]',
		warning: 'text-[var(--status-warning-fg)]',
		info: 'border-[var(--accent)] text-[var(--accent-text)]',
		neutral: 'text-[var(--status-neutral-fg)]'
	};
</script>

{#if !dismissed}
	<div
		role="alert"
		class={cn(
			'relative flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)] px-4 py-3 text-[13px] leading-[1.5]',
			toneClass[tone],
			dismissible && 'pr-9',
			className
		)}
	>
		<div class="flex min-w-0 flex-col gap-1">
			{#if title}<p class="font-medium">{title}</p>{/if}
			{#if children}<div class="text-[var(--muted-fg)]">{@render children()}</div>{/if}
		</div>
		{#if actions}<div class="mt-1 flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
		{#if dismissible}
			<button
				type="button"
				onclick={handleDismiss}
				aria-label="Dismiss"
				class="absolute right-3 top-3 opacity-70 transition-opacity duration-150 hover:opacity-100"
			>
				<svg class="size-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75">
					<path stroke-linecap="round" d="M6 6l8 8M14 6l-8 8" />
				</svg>
			</button>
		{/if}
	</div>
{/if}
