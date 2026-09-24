<script lang="ts" module>
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";
	import { type VariantProps, tv } from "tailwind-variants";

	export const badgeVariants = tv({
		base: "inline-flex items-center whitespace-nowrap rounded-[var(--radius-pill)] border border-[var(--ds-border)] bg-[var(--surface)] px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.01em] text-[var(--muted-fg)]",
		variants: {
			variant: {
				default: "border-transparent bg-[var(--accent)] text-[var(--accent-fg)]",
				secondary: "",
				outline: "",
				destructive: "border-[oklch(0.58_0.19_27)] text-[oklch(0.58_0.19_27)]",
				red: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
				blue: "bg-[var(--status-info-bg)] text-[var(--status-info-fg)]",
				green: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
				yellow: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
				purple: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
				pink: "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400",
				orange: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
				cyan: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400",
				indigo: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
				violet: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
				rose: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
				amber: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
				lime: "bg-lime-100 text-lime-700 dark:bg-lime-900/30 dark:text-lime-400",
				emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
				sky: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
				slate: "bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-400",
				fuchsia: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-400",
			},
			size: {
				default: "",
				sm: "px-2 py-0.5",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];
	export type BadgeSize = VariantProps<typeof badgeVariants>["size"];

	export type BadgeProps = WithElementRef<HTMLAttributes<HTMLSpanElement>, HTMLSpanElement> & {
		variant?: BadgeVariant;
		size?: BadgeSize;
	};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		children,
		...restProps
	}: BadgeProps = $props();
</script>

<span
	bind:this={ref}
	data-slot="badge"
	class={cn(badgeVariants({ variant, size }), className)}
	{...restProps}
>
	{@render children?.()}
</span>
