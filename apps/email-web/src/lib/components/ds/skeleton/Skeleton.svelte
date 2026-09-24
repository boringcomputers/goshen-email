<script lang="ts">
	import { cn } from '$lib/utils.js';

	let {
		class: className
	}: {
		class?: string;
	} = $props();
</script>

<div
	class={cn('skeleton h-3 rounded-[var(--radius-inner)] bg-[var(--surface-2)]', className)}
	aria-hidden="true"
></div>

<style>
	.skeleton {
		animation: pulse 1.6s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.45;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.skeleton {
			animation-duration: 0.01ms;
			animation-iteration-count: 1;
		}
	}
</style>
