<script lang="ts" module>
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
	import { type VariantProps, tv } from "tailwind-variants";

	export const buttonVariants = tv({
		base: "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-pill)] text-[13px] font-medium outline-none transition-[opacity,border-color,color,transform] duration-150 [transition-timing-function:var(--ease-out-ds)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
		variants: {
			variant: {
				default: "bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-85",
				destructive: "bg-[oklch(0.58_0.19_27)] text-white hover:opacity-85",
				outline:
					"border border-[var(--ds-border)] bg-[var(--surface)] text-[var(--fg)] hover:border-[var(--border-strong)]",
				secondary:
					"border border-[var(--ds-border)] bg-[var(--surface)] text-[var(--fg)] hover:border-[var(--border-strong)]",
				ghost: "text-[var(--muted-fg)] hover:text-[var(--fg)]",
				link: "text-[var(--accent-text)] underline-offset-4 hover:text-[var(--fg)]",
			},
			size: {
				default: "h-8 px-4",
				sm: "h-7 px-3 text-[12px]",
				lg: "h-9 px-4 text-[14px] tracking-[-0.01em]",
				icon: "size-8 p-0",
				"icon-sm": "size-7 p-0",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
