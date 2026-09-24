<script lang="ts">
	import { cn } from '$lib/utils.js';
	import { Select as SelectPrimitive } from 'bits-ui';

	export type SelectOption = {
		value: string;
		label: string;
		disabled?: boolean;
	};

	type Props = {
		value: string;
		options: SelectOption[];
		placeholder?: string;
		disabled?: boolean;
		id?: string;
		class?: string;
		contentClass?: string;
		ariaLabel?: string;
		onValueChange?: (value: string) => void;
	};

	let {
		value = $bindable(''),
		options,
		placeholder = 'Select…',
		disabled = false,
		id,
		class: className = '',
		contentClass = '',
		ariaLabel,
		onValueChange
	}: Props = $props();

	const selectedLabel = $derived(options.find((o) => o.value === value)?.label);
</script>

<SelectPrimitive.Root
	type="single"
	bind:value
	items={options}
	{disabled}
	onValueChange={(v) => onValueChange?.(v)}
>
	<SelectPrimitive.Trigger
		{id}
		aria-label={ariaLabel}
		class={cn(
			'flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)] px-3.5 py-2.5 text-left text-[13px] text-[var(--fg)] outline-none transition-[border-color] duration-150 focus:border-[var(--accent-text)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-[var(--accent-text)]',
			className
		)}
	>
		<span class={cn('truncate', !selectedLabel && 'text-[var(--muted-fg)]')}>
			{selectedLabel ?? placeholder}
		</span>
		<svg
			class="h-4 w-4 shrink-0 text-[var(--muted-fg)] transition-transform data-[state=open]:rotate-180"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			stroke-width="2"
			aria-hidden="true"
		>
			<path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
		</svg>
	</SelectPrimitive.Trigger>

	<SelectPrimitive.Portal>
		<SelectPrimitive.Content
			class={cn(
				'z-[60] max-h-[var(--bits-select-content-available-height)] w-[var(--bits-select-anchor-width)] min-w-[8rem] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--popover)] p-1.5 outline-none',
				contentClass
			)}
			sideOffset={4}
		>
			{#each options as option (option.value)}
				<SelectPrimitive.Item
					value={option.value}
					label={option.label}
					disabled={option.disabled}
					class="flex w-full cursor-pointer select-none items-center justify-between gap-2 rounded-[var(--radius-inner)] px-2.5 py-2 text-[13px] text-[var(--muted-fg)] outline-none data-disabled:cursor-not-allowed data-disabled:opacity-50 data-highlighted:bg-[var(--surface-2)] data-highlighted:text-[var(--fg)] data-selected:text-[var(--fg)]"
				>
					{#snippet children({ selected })}
						<span class="truncate">{option.label}</span>
						{#if selected}
							<svg
								class="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								stroke-width="2.5"
								aria-hidden="true"
							>
								<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
							</svg>
						{/if}
					{/snippet}
				</SelectPrimitive.Item>
			{/each}
		</SelectPrimitive.Content>
	</SelectPrimitive.Portal>
</SelectPrimitive.Root>
