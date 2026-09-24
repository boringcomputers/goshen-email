<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title?: string;
		description?: string;
		children?: Snippet;
		actions?: Snippet;
	}
	let { title = '', description = '', children, actions }: Props = $props();
</script>

<div class="relative flex min-h-full flex-col px-5 py-4 w-full">
	{#if title || description || actions}
		<header class="mb-2 flex items-start justify-between gap-4">
			<div>
				{#if title}
					<h1 class="text-[16px] font-medium tracking-[-0.01em] text-foreground">{title}</h1>
				{/if}
				{#if description}
					<p class="mt-1 text-[13px] text-[var(--muted-fg)]">{description}</p>
				{/if}
			</div>
			{#if actions}
				<div class="flex shrink-0 items-center gap-2">
					{@render actions()}
				</div>
			{/if}
		</header>
	{/if}
	<div class="flex flex-1 flex-col w-full">
		{@render children?.()}
	</div>
</div>
