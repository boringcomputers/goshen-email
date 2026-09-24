<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";

	let {
		ref = $bindable(null),
		class: className,
		inset,
		variant = "default",
		...restProps
	}: DropdownMenuPrimitive.ItemProps & {
		inset?: boolean;
		variant?: "default" | "destructive";
	} = $props();
</script>

<DropdownMenuPrimitive.Item
	bind:ref
	data-slot="dropdown-menu-item"
	data-inset={inset}
	data-variant={variant}
	class={cn(
		"data-highlighted:bg-[var(--surface-2)] data-highlighted:text-[var(--fg)] data-[variant=destructive]:text-[oklch(0.58_0.19_27)] data-[variant=destructive]:data-highlighted:text-[oklch(0.58_0.19_27)] relative flex w-full cursor-pointer select-none items-center gap-2 rounded-[var(--radius-inner)] px-2.5 py-2 text-[13px] text-[var(--muted-fg)] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:ps-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
		className
	)}
	{...restProps}
/>
