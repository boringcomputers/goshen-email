<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils.js';
	import EmptyState from './EmptyState.svelte';

	let {
		title,
		description,
		class: className,
		icon,
		actions,
		children
	}: {
		title: string;
		description?: string;
		class?: string;
		icon?: Snippet;
		actions?: Snippet;
		children?: Snippet;
	} = $props();
</script>

<!-- Full-page empty state: stretches to fill the remaining PageShell height.
     Always uses the dashed variant so every page-level empty state looks the same. -->
<EmptyState
	{title}
	{description}
	variant="dashed"
	class={cn('min-h-0 flex-1 justify-center', className)}
	{icon}
	{actions}
	{children}
/>
