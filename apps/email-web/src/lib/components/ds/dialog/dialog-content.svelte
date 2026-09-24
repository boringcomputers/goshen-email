<script lang="ts">
	import XIcon from "@lucide/svelte/icons/x";
	import { cn } from "$lib/utils.js";
	import { Dialog as DialogPrimitive } from "bits-ui";
	import DialogOverlay from "./dialog-overlay.svelte";

	let {
		ref = $bindable(null),
		class: className,
		showCloseButton = true,
		children,
		...restProps
	}: DialogPrimitive.ContentProps & { showCloseButton?: boolean } = $props();
</script>

<DialogPrimitive.Portal>
	<DialogOverlay />
	<DialogPrimitive.Content
		bind:ref
		class={cn(
			"fixed left-1/2 top-1/2 z-50 flex w-[360px] max-w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-2.5 rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--popover)] p-6 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		{#if showCloseButton}
			<DialogPrimitive.Close
				class="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-inner)] text-[var(--muted-fg)] transition-colors duration-150 hover:bg-[var(--surface-2)] hover:text-[var(--fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40 disabled:pointer-events-none"
			>
				<XIcon class="h-4 w-4" aria-hidden="true" />
				<span class="sr-only">Close</span>
			</DialogPrimitive.Close>
		{/if}
	</DialogPrimitive.Content>
</DialogPrimitive.Portal>
