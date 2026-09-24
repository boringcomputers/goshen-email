<script lang="ts">
	import { cn } from '$lib/utils.js';

	let {
		size = 18,
		label = 'Loading',
		class: className
	}: {
		/** Rendered width/height in px. */
		size?: number;
		/** Accessible label for the status indicator. */
		label?: string;
		class?: string;
	} = $props();
</script>

<svg
	class={cn('spinner shrink-0', className)}
	width={size}
	height={size}
	viewBox="0 0 18 18"
	role="status"
	aria-label={label}
>
	<circle cx="9" cy="9" r="7" fill="none" stroke="var(--ds-border)" stroke-width="2" />
	<path
		d="M9 2a7 7 0 0 1 7 7"
		fill="none"
		stroke="var(--accent)"
		stroke-width="2"
		stroke-linecap="round"
	/>
</svg>

<style>
	.spinner {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 0.01ms;
			animation-iteration-count: 1;
		}
	}
</style>
