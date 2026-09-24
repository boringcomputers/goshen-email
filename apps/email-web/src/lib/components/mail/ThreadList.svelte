<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Button } from '$lib/components/ds/button';
	import { Skeleton } from '$lib/components/ds/skeleton';
	import { listDate } from '$lib/services/format';
	import type { ThreadSummary } from '$lib/services/types';
	import TriageBadges from './TriageBadges.svelte';

	let {
		threads,
		selected,
		loading = false,
		more = false,
		emptyTitle,
		emptyDescription,
		heldPreview = false,
		onSelect,
		onMore,
		failure
	}: {
		threads: ThreadSummary[];
		selected: string;
		loading?: boolean;
		more?: boolean;
		emptyTitle: string;
		emptyDescription: string;
		heldPreview?: boolean;
		onSelect: (threadId: string) => void;
		onMore?: () => void;
		failure?: Snippet;
	} = $props();
</script>

<div class="flex-1 overflow-auto" aria-label="Conversations">
	{#if failure}
		{@render failure()}
	{:else if loading && threads.length === 0}
		<div class="space-y-4 px-3 py-3" aria-busy="true">
			{#each [0, 1, 2, 3] as row (row)}
				<div class="space-y-1.5">
					<Skeleton class="w-1/3" />
					<Skeleton class="w-3/4" />
					<Skeleton class="w-2/3" />
				</div>
			{/each}
		</div>
	{:else if threads.length === 0}
		<div class="px-3 py-6 text-center">
			<p class="text-[13px] font-medium text-foreground">{emptyTitle}</p>
			<p class="mt-1 text-[12px] text-[var(--muted-fg)]">{emptyDescription}</p>
		</div>
	{:else}
		<ul>
			{#each threads as thread (thread.threadId)}
				{@const unread = thread.labels?.includes('unread')}
				<li>
					<button
						type="button"
						class="flex w-full flex-col items-start gap-0.5 border-b border-[var(--border-color)] px-3 py-2.5 text-left transition-colors duration-150 hover:bg-[var(--surface-2)] {selected ===
						thread.threadId
							? 'bg-[var(--active)]'
							: ''}"
						aria-pressed={selected === thread.threadId}
						data-thread-id={thread.threadId}
						onclick={() => onSelect(thread.threadId)}
					>
						<span class="flex w-full items-center gap-2">
							{#if unread}<span class="size-1.5 shrink-0 rounded-full bg-[var(--accent)]" aria-label="Unread"></span>{/if}
							<span class="min-w-0 flex-1 truncate text-[12px] {unread ? 'font-medium text-foreground' : 'text-[var(--muted-fg)]'}">
								{thread.senders.join(', ') || '(unknown sender)'}
							</span>
							<time class="shrink-0 text-[11px] tabular-nums text-[var(--muted-fg)]" datetime={thread.timestamp}>{listDate(thread.timestamp)}</time>
						</span>
						<span class="w-full truncate text-[13px] {unread ? 'font-medium' : ''} text-foreground">{thread.subject || '(No subject)'}</span>
						<span class="w-full truncate text-[12px] text-[var(--muted-fg)]">
							{thread.preview || (heldPreview ? 'Held for your review' : 'No preview')}
						</span>
						{#if thread.triage}<span class="mt-1"><TriageBadges triage={thread.triage} /></span>{/if}
					</button>
				</li>
			{/each}
		</ul>
		{#if more && onMore}
			<div class="p-3">
				<Button variant="secondary" size="sm" class="w-full" disabled={loading} onclick={onMore}>
					{loading ? 'Loading…' : 'Load more'}
				</Button>
			</div>
		{/if}
	{/if}
</div>
