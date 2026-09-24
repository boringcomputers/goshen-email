<script lang="ts">
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { toast } from 'svelte-sonner';
	import { Badge } from '$lib/components/ds/badge';
	import { Button } from '$lib/components/ds/button';
	import * as DropdownMenu from '$lib/components/ds/dropdown-menu/index.js';
	import { Input } from '$lib/components/ds/input';
	import { InlineAlert, PageEmptyState } from '$lib/components/ds/patterns';
	import { Select } from '$lib/components/ds/select';
	import PageShell from '$lib/components/PageShell.svelte';
	import { shortDate } from '$lib/services/format';
	import { filterInboxes, inboxGroups, paginate } from '$lib/services/mail';
	import type { Inbox } from '$lib/services/types';
	import { useWorkspace } from '$lib/workspace.svelte';

	const workspace = useWorkspace();
	const pageSize = 10;

	let query = $state('');
	let group = $state('');
	let pageNumber = $state(0);
	let refreshing = $state(false);

	const groups = $derived(inboxGroups(workspace.inboxes));
	const filtered = $derived(filterInboxes(workspace.inboxes, query, groups.includes(group) ? group : ''));
	const view = $derived(paginate(filtered, pageNumber, pageSize));
	const countLabel = $derived(
		`${filtered.length} inbox${filtered.length === 1 ? '' : 'es'}${filtered.length !== workspace.inboxes.length ? ` of ${workspace.inboxes.length}` : ''}`
	);

	async function refresh() {
		refreshing = true;
		try {
			await workspace.loadInboxes();
		} catch {
			// The error is shown above the table.
		} finally {
			refreshing = false;
		}
	}

	async function copyAddress(inbox: Inbox) {
		try {
			await navigator.clipboard.writeText(inbox.address || inbox.inboxId);
			toast.success('Email address copied');
		} catch {
			toast.error('Could not copy the address. Select it to copy manually.');
		}
	}

	const headClass = 'border-b border-[var(--ds-border)] px-4 py-2.5 text-left text-[11px] font-medium uppercase text-[var(--muted-fg)]';
	const cellClass = 'border-b border-[var(--ds-border)] px-4 py-3';
</script>

<svelte:head>
	<title>Inboxes · Goshen Email</title>
</svelte:head>

<PageShell title="Inboxes" description="Create and manage email addresses for your agents.">
	{#snippet actions()}
		<Button onclick={() => (workspace.creatingInbox = true)}><PlusIcon aria-hidden="true" /> Create inbox</Button>
	{/snippet}

	<div class="mt-3 mb-3 flex flex-wrap items-center gap-2">
		<div class="relative w-full max-w-xs">
			<SearchIcon class="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[var(--muted-fg)]" aria-hidden="true" />
			<Input
				type="search"
				bind:value={query}
				oninput={() => (pageNumber = 0)}
				class="py-2 pl-8"
				placeholder="Search inboxes…"
				aria-label="Search inboxes"
			/>
		</div>
		{#if groups.length}
			<Select
				ariaLabel="Filter by group"
				class="w-44 py-2"
				value={group || 'all'}
				options={[{ value: 'all', label: 'All groups' }, ...groups.map((name) => ({ value: name, label: name }))]}
				onValueChange={(value) => {
					group = value === 'all' ? '' : value;
					pageNumber = 0;
				}}
			/>
		{/if}
		<Button variant="ghost" size="icon" class="ml-auto" aria-label="Refresh inboxes" title="Refresh inboxes" disabled={refreshing} onclick={refresh}>
			<RefreshCwIcon aria-hidden="true" />
		</Button>
	</div>

	{#if workspace.inboxesError}
		<InlineAlert tone="danger" class="mb-3">{workspace.inboxesError}</InlineAlert>
	{/if}

	{#if workspace.inboxes.length === 0 && !workspace.inboxesError}
		<PageEmptyState title="Create your first inbox" description="Give your agent an email address to send and receive mail.">
			{#snippet icon()}<InboxIcon class="size-4" aria-hidden="true" />{/snippet}
			{#snippet actions()}
				<Button onclick={() => (workspace.creatingInbox = true)}>Create inbox</Button>
			{/snippet}
		</PageEmptyState>
	{:else}
		<div class="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)]">
			<table class="w-full border-collapse text-[13px]">
				<thead>
					<tr>
						<th scope="col" class={headClass}>Inbox</th>
						<th scope="col" class="{headClass} hidden md:table-cell">Group</th>
						<th scope="col" class={headClass}>Status</th>
						<th scope="col" class="{headClass} hidden md:table-cell">Created</th>
						<th scope="col" class="{headClass} w-12"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each view.items as inbox (inbox.inboxId)}
						<tr class="transition-colors duration-150 hover:bg-[var(--surface-2)] [&:last-child>td]:border-b-0" data-inbox-id={inbox.inboxId}>
							<td class={cellClass}>
								<a href={`/inboxes/${encodeURIComponent(inbox.inboxId)}`} class="flex min-w-0 items-center gap-3">
									<span class="flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-[var(--ds-border)] bg-[var(--surface-2)] text-[var(--muted-fg)]">
										<InboxIcon class="size-4" aria-hidden="true" />
									</span>
									<span class="min-w-0">
										<span class="block truncate font-medium text-foreground">{inbox.displayName || inbox.inboxId}</span>
										<span class="block truncate text-[12px] text-[var(--muted-fg)]">{inbox.address || inbox.inboxId}</span>
									</span>
								</a>
							</td>
							<td class="{cellClass} hidden text-[var(--muted-fg)] md:table-cell">{inbox.group || 'Ungrouped'}</td>
							<td class={cellClass}>
								{#if inbox.deliveryStatus === 'pending'}
									<Badge variant="amber" size="sm">Setup pending</Badge>
								{:else}
									<Badge variant="emerald" size="sm">Ready</Badge>
								{/if}
							</td>
							<td class="{cellClass} hidden text-[var(--muted-fg)] tabular-nums md:table-cell">{shortDate(inbox.createdAt)}</td>
							<td class="{cellClass} text-right">
								<DropdownMenu.Root>
									<DropdownMenu.Trigger
										class="inline-flex size-7 items-center justify-center rounded-[var(--radius-inner)] text-[var(--muted-fg)] transition-colors duration-150 hover:bg-[var(--surface-2)] hover:text-foreground"
										aria-label={`Options for ${inbox.inboxId}`}
										title="Inbox options"
									>
										<EllipsisIcon class="size-4" aria-hidden="true" />
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end" class="w-48">
										<DropdownMenu.Item onclick={() => copyAddress(inbox)}><CopyIcon aria-hidden="true" /> Copy email address</DropdownMenu.Item>
										{#if workspace.isCustomer}
											<DropdownMenu.Item onclick={() => (workspace.credentialsFor = inbox.inboxId)}>
												<KeyRoundIcon aria-hidden="true" /> Mailbox API key
											</DropdownMenu.Item>
										{/if}
										<DropdownMenu.Item variant="destructive" onclick={() => (workspace.deleting = inbox)}>
											<Trash2Icon aria-hidden="true" /> Delete inbox…
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="5" class="px-4 py-8 text-center">
								<p class="text-[13px] font-medium text-foreground">No inboxes found</p>
								<p class="mt-1 text-[12px] text-[var(--muted-fg)]">Try a different name, address, or group.</p>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<footer class="mt-3 flex items-center justify-between text-[12px] text-[var(--muted-fg)]">
			<span role="status" data-testid="inbox-count">{countLabel}</span>
			<span class="flex items-center gap-2">
				<Button variant="ghost" size="icon-sm" aria-label="Previous inbox page" disabled={view.page === 0} onclick={() => (pageNumber = view.page - 1)}>
					<ChevronLeftIcon aria-hidden="true" />
				</Button>
				<span class="tabular-nums">Page {view.page + 1} of {view.pages}</span>
				<Button variant="ghost" size="icon-sm" aria-label="Next inbox page" disabled={view.page + 1 === view.pages} onclick={() => (pageNumber = view.page + 1)}>
					<ChevronRightIcon aria-hidden="true" />
				</Button>
			</span>
		</footer>
	{/if}
</PageShell>
