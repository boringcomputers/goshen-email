<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import ListFilterIcon from '@lucide/svelte/icons/list-filter';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SendIcon from '@lucide/svelte/icons/send';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ds/button';
	import * as DropdownMenu from '$lib/components/ds/dropdown-menu/index.js';
	import { Input } from '$lib/components/ds/input';
	import { EmptyState, InlineAlert } from '$lib/components/ds/patterns';
	import { Select } from '$lib/components/ds/select';
	import { Spinner } from '$lib/components/ds/spinner';
	import MessageCard from '$lib/components/mail/MessageCard.svelte';
	import ReplyBox from '$lib/components/mail/ReplyBox.svelte';
	import ThreadList from '$lib/components/mail/ThreadList.svelte';
	import { plural } from '$lib/services/format';
	import {
		folders,
		inboxLabel,
		mergeThreads,
		replyTarget,
		safeDownloadUrl,
		threadActions,
		threadItems,
		threadOperation,
		threadRequest,
		triageOptions,
		type Folder,
		type LabelAction,
		type TriageFilters
	} from '$lib/services/mail';
	import type { Attachment, Message, Thread, ThreadSummary } from '$lib/services/types';
	import { useWorkspace } from '$lib/workspace.svelte';

	const workspace = useWorkspace();

	const folderIcons = { inbox: InboxIcon, sent: SendIcon, all: LayersIcon, quarantined: ShieldAlertIcon, trash: Trash2Icon };
	const actionIcons = { archive: ArchiveIcon, trash: Trash2Icon, restore: InboxIcon };

	const inboxId = $derived(page.params.inboxId ?? '');
	const inbox = $derived(workspace.inboxes.find((item) => item.inboxId === inboxId));

	let folder = $state<Folder>('inbox');
	let query = $state('');
	let activeQuery = $state('');
	let filters = $state<TriageFilters>({});
	let filtersOpen = $state(false);

	let threads = $state<ThreadSummary[]>([]);
	let nextPage = $state<string | undefined>();
	let listLoading = $state(false);
	let listError = $state('');
	let selected = $state('');
	let thread = $state<Thread | null>(null);
	let readLoading = $state(false);
	let readError = $state('');
	let actionBusy = $state('');
	let listVersion = 0, readVersion = 0;

	const filtered = $derived(Object.keys(filters).length > 0);
	const folderTitle = $derived(activeQuery ? 'Search results' : (folders.find((item) => item.key === folder)?.label ?? 'Inbox'));
	const target = $derived(thread ? replyTarget(thread.messages) : undefined);

	// A new inbox starts with no search and no filters; the folder carries over.
	$effect(() => {
		void inboxId;
		untrack(() => {
			query = activeQuery = '';
			filters = {};
			workspace.currentInboxId = inboxId;
		});
	});

	$effect(() => {
		if (workspace.inboxesLoaded && !inbox) {
			toast.error('This inbox is no longer available.');
			void goto('/inboxes', { replaceState: true });
		}
	});

	$effect(() => {
		void [inboxId, folder, activeQuery, filters, workspace.mailVersion];
		if (!inbox) return;
		untrack(() => void loadThreads());
	});

	async function loadThreads({ append = false, keepSelection = false } = {}) {
		const version = ++listVersion, target = inboxId;
		if (!append && !keepSelection) {
			readVersion++;
			selected = '';
			thread = null;
			readError = '';
			threads = [];
			nextPage = undefined;
		}
		listLoading = true;
		listError = '';
		try {
			const request = threadRequest({ inboxId: target, folder, query: activeQuery, filters, pageToken: append ? nextPage : undefined });
			const result = await workspace.rpc<{ threads?: ThreadSummary[]; messages?: ThreadSummary[]; nextPageToken?: string }>(
				request.operation,
				request.input
			);
			if (version !== listVersion) return;
			threads = mergeThreads(append ? threads : [], threadItems(result));
			nextPage = result.nextPageToken;
		} catch (error) {
			if (version !== listVersion) return;
			threads = [];
			nextPage = undefined;
			listError = error instanceof Error ? error.message : 'Mail could not load.';
		} finally {
			if (version === listVersion) listLoading = false;
		}
	}

	async function readThread(threadId: string, { keep = false } = {}) {
		const version = ++readVersion, target = inboxId;
		selected = threadId;
		if (!keep) thread = null;
		readLoading = true;
		readError = '';
		try {
			const result = await workspace.rpc<Thread>(threadOperation(folder), { inboxId: target, threadId, includeBodies: true });
			if (version !== readVersion) return;
			thread = result;
			if (result.labels.includes('unread')) {
				threads = threads.map((item) =>
					item.threadId === threadId ? { ...item, labels: item.labels?.filter((label) => label !== 'unread') } : item
				);
				void workspace
					.rpc('updateThreadLabels', { inboxId: target, threadId, removeLabels: ['unread'] })
					.catch((error) => toast.error(error.message));
			}
		} catch (error) {
			if (version === readVersion) readError = error instanceof Error ? error.message : 'The conversation could not open.';
		} finally {
			if (version === readVersion) readLoading = false;
		}
	}

	function chooseFolder(next: Folder) {
		folder = next;
		query = activeQuery = '';
		filters = {};
	}

	function search(event: SubmitEvent) {
		event.preventDefault();
		activeQuery = query.trim();
	}

	function setFilter(field: keyof TriageFilters, value: string) {
		const next = { ...filters };
		if (value && value !== 'any') next[field] = value;
		else delete next[field];
		filters = next;
	}

	async function applyLabels(action: LabelAction) {
		const current = thread;
		if (!current || actionBusy) return;
		actionBusy = action.key;
		try {
			await workspace.rpc('updateThreadLabels', { inboxId, threadId: current.threadId, ...action.changes });
			toast.success('Conversation updated');
			await loadThreads();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'The conversation could not be updated.');
		} finally {
			actionBusy = '';
		}
	}

	async function release(message: Message) {
		try {
			await workspace.rpc('releaseQuarantine', { inboxId, messageId: message.messageId });
			toast.success('Message released');
			const threadId = selected;
			await loadThreads({ keepSelection: true });
			if (threadId) await readThread(threadId, { keep: true });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'The message could not be released.');
		}
	}

	async function download(message: Message, attachment: Attachment) {
		try {
			const result = await workspace.rpc<{ downloadUrl: string }>('getAttachment', {
				inboxId,
				messageId: message.messageId,
				attachmentId: attachment.attachmentId
			});
			const link = document.createElement('a');
			link.href = safeDownloadUrl(result.downloadUrl);
			link.rel = 'noreferrer noopener';
			link.target = '_blank';
			link.click();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'The attachment could not be downloaded.');
		}
	}

	async function replied() {
		const threadId = selected;
		await loadThreads({ keepSelection: true });
		if (threadId) await readThread(threadId, { keep: true });
	}

	async function finishSetup() {
		if (actionBusy) return;
		actionBusy = 'finish';
		try {
			await workspace.rpc('finishInboxSetup', { inboxId });
			await workspace.loadInboxes(inboxId);
			toast.success('Inbox delivery is ready');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Delivery setup did not finish.');
		} finally {
			actionBusy = '';
		}
	}

	async function copyAddress() {
		try {
			await navigator.clipboard.writeText(inbox?.address || inboxId);
			toast.success('Email address copied');
		} catch {
			toast.error('Could not copy the address. Select it to copy manually.');
		}
	}

	const selectClass = 'py-2 text-[12px]';
</script>

<svelte:head>
	<title>{inbox?.displayName || inboxId} · Goshen Email</title>
</svelte:head>

{#snippet triageFilters()}
	<div class="space-y-2">
		<div class="flex items-center justify-between">
			<span class="text-[12px] font-medium uppercase tracking-[0.01em] text-[var(--muted-fg)]">Triage</span>
			{#if filtered}
				<button type="button" class="text-[12px] text-[var(--muted-fg)] hover:text-foreground" onclick={() => (filters = {})}>Clear</button>
			{/if}
		</div>
		<Select
			ariaLabel="Category"
			class={selectClass}
			value={filters.category ?? 'any'}
			options={[{ value: 'any', label: 'Any category' }, ...triageOptions.category.map(([value, label]) => ({ value, label }))]}
			onValueChange={(value) => setFilter('category', value)}
		/>
		<Select
			ariaLabel="Response"
			class={selectClass}
			value={filters.needsReply ?? 'any'}
			options={[{ value: 'any', label: 'Any response' }, ...triageOptions.needsReply.map(([value, label]) => ({ value, label }))]}
			onValueChange={(value) => setFilter('needsReply', value)}
		/>
		<Select
			ariaLabel="Urgency"
			class={selectClass}
			value={filters.urgency ?? 'any'}
			options={[{ value: 'any', label: 'Any urgency' }, ...triageOptions.urgency.map(([value, label]) => ({ value, label }))]}
			onValueChange={(value) => setFilter('urgency', value)}
		/>
	</div>
{/snippet}

<div class="flex h-full flex-col px-5 py-4">
	<header class="mb-3 flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<a href="/inboxes" class="mb-1 inline-flex items-center gap-1 text-[12px] text-[var(--muted-fg)] hover:text-foreground">
				<ArrowLeftIcon class="size-3.5" aria-hidden="true" /> All inboxes
			</a>
			<h1 class="truncate text-[16px] font-medium tracking-[-0.01em] text-foreground">{inbox?.displayName || inboxId}</h1>
			<div class="mt-1 flex items-center gap-1.5 text-[13px] text-[var(--muted-fg)]">
				<span class="truncate" data-testid="mailbox-address">{inbox?.address || inboxId}</span>
				<button
					type="button"
					class="inline-flex size-6 items-center justify-center rounded-[var(--radius-inner)] hover:bg-[var(--surface-2)] hover:text-foreground"
					aria-label="Copy email address"
					title="Copy email address"
					onclick={copyAddress}
				>
					<CopyIcon class="size-3.5" aria-hidden="true" />
				</button>
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			{#if workspace.inboxes.length > 1}
				<Select
					ariaLabel="Mailbox"
					class="w-[240px] py-1.5"
					value={inboxId}
					options={workspace.inboxes.map((item) => ({ value: item.inboxId, label: inboxLabel(item) }))}
					onValueChange={(value) => value !== inboxId && void goto(`/inboxes/${encodeURIComponent(value)}`)}
				/>
			{/if}
			{#if inbox?.deliveryStatus === 'pending'}
				<Button variant="outline" disabled={actionBusy === 'finish'} onclick={finishSetup}>Finish setup</Button>
			{/if}
			<Button onclick={() => (workspace.composeFor = inboxId)}>
				<PlusIcon aria-hidden="true" /> Compose
			</Button>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger
					class="inline-flex size-8 items-center justify-center rounded-[var(--radius-pill)] border border-[var(--ds-border)] bg-[var(--surface)] text-[var(--muted-fg)] transition-colors duration-150 hover:border-[var(--border-strong)] hover:text-foreground"
					aria-label="Inbox options"
					title="Inbox options"
				>
					<EllipsisIcon class="size-4" aria-hidden="true" />
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-48">
					{#if workspace.isCustomer}
						<DropdownMenu.Item onclick={() => (workspace.credentialsFor = inboxId)}>
							<KeyRoundIcon aria-hidden="true" /> Mailbox API key
						</DropdownMenu.Item>
					{/if}
					<DropdownMenu.Item variant="destructive" disabled={!inbox} onclick={() => inbox && (workspace.deleting = inbox)}>
						<Trash2Icon aria-hidden="true" /> Delete inbox…
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>
	</header>

	<div
		class="grid min-h-0 flex-1 overflow-hidden rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)] md:grid-cols-[300px_1fr] lg:grid-cols-[200px_340px_1fr]"
	>
		<aside class="hidden min-h-0 flex-col border-r border-[var(--border-color)] lg:flex" aria-label="Email folders">
			<div class="flex h-10 shrink-0 items-center border-b border-[var(--border-color)] px-3">
				<span class="text-[12px] font-medium uppercase tracking-[0.01em] text-[var(--muted-fg)]">Folders</span>
			</div>
			<nav class="space-y-0.5 p-2">
				{#each folders as item (item.key)}
					{@const Icon = folderIcons[item.key]}
					{@const active = !activeQuery && folder === item.key}
					<button
						type="button"
						class="flex min-h-8 w-full items-center gap-2.5 rounded-[var(--radius-inner)] px-2.5 py-1 text-[13px] font-medium transition-colors duration-150 {active
							? 'bg-[var(--active)] text-[var(--fg)]'
							: 'text-[var(--muted-fg)] hover:text-[var(--fg)]'}"
						aria-current={active ? 'page' : undefined}
						data-folder={item.key}
						onclick={() => chooseFolder(item.key)}
					>
						<Icon class="size-4 {active ? 'text-[var(--accent)]' : ''}" aria-hidden="true" />
						{item.label}
					</button>
				{/each}
			</nav>
			{#if folder !== 'quarantined'}
				<div class="border-t border-[var(--border-color)] p-3">{@render triageFilters()}</div>
			{/if}
		</aside>

		<section
			class="min-h-0 flex-col border-r border-[var(--border-color)] {selected ? 'hidden md:flex' : 'flex'}"
			aria-label="Messages"
		>
			<div class="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-color)] px-3">
				<span class="flex items-center gap-2 text-[12px] font-medium uppercase tracking-[0.01em] text-[var(--muted-fg)]">
					<span data-testid="folder-title">{folderTitle}</span>
					{#if threads.length}
						<span class="tabular-nums text-[var(--subtle)]" data-testid="thread-count">{threads.length}{nextPage ? '+' : ''}</span>
					{/if}
				</span>
				<span class="flex items-center">
					{#if folder !== 'quarantined'}
						<button
							type="button"
							class="inline-flex size-7 items-center justify-center rounded-[var(--radius-inner)] text-[var(--muted-fg)] hover:bg-[var(--surface-2)] hover:text-foreground lg:hidden {filtered
								? 'text-[var(--accent)]'
								: ''}"
							aria-label="Filter messages"
							title="Filter messages"
							aria-expanded={filtersOpen}
							onclick={() => (filtersOpen = !filtersOpen)}
						>
							<ListFilterIcon class="size-4" aria-hidden="true" />
						</button>
					{/if}
					<button
						type="button"
						class="inline-flex size-7 items-center justify-center rounded-[var(--radius-inner)] text-[var(--muted-fg)] hover:bg-[var(--surface-2)] hover:text-foreground disabled:opacity-50"
						aria-label="Refresh messages"
						title="Refresh messages"
						disabled={listLoading}
						onclick={() => loadThreads()}
					>
						<RefreshCwIcon class="size-4" aria-hidden="true" />
					</button>
				</span>
			</div>
			<div class="space-y-2 border-b border-[var(--border-color)] p-2.5">
				<form class="relative" onsubmit={search} role="search">
					<SearchIcon class="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[var(--muted-fg)]" aria-hidden="true" />
					<Input type="search" bind:value={query} class="py-2 pl-8 text-[12px]" placeholder="Search this inbox" aria-label="Search mail" />
				</form>
				<div class="lg:hidden">
					<Select
						ariaLabel="Folder"
						class={selectClass}
						value={folder}
						options={folders.map((item) => ({ value: item.key, label: item.label }))}
						onValueChange={(value) => chooseFolder(value as Folder)}
					/>
				</div>
				{#if filtersOpen && folder !== 'quarantined'}
					<div class="lg:hidden">{@render triageFilters()}</div>
				{/if}
			</div>
			<ThreadList
				{threads}
				{selected}
				loading={listLoading}
				more={Boolean(nextPage)}
				heldPreview={folder === 'quarantined'}
				emptyTitle={activeQuery || filtered ? 'No matching messages' : 'No conversations yet'}
				emptyDescription={filtered
					? 'Try different triage filters or clear them to see all conversations.'
					: activeQuery
						? 'Try a different search in this mailbox.'
						: 'Messages in this folder will appear here.'}
				onSelect={(threadId) => readThread(threadId)}
				onMore={() => loadThreads({ append: true })}
				failure={listError ? listFailure : undefined}
			/>
		</section>

		<section class="min-h-0 flex-col overflow-hidden {selected ? 'flex' : 'hidden md:flex'}" aria-label="Conversation">
			{#if !selected}
				<div class="flex flex-1 items-center justify-center p-6">
					<EmptyState title="A little room to focus." description="Select a conversation to read your mail." class="w-full max-w-sm" />
				</div>
			{:else if readError}
				<div class="flex flex-1 items-center justify-center p-6">
					<EmptyState title="Could not open conversation" description={readError} class="w-full max-w-sm">
						{#snippet actions()}
							<Button variant="secondary" size="sm" onclick={() => readThread(selected)}>Try again</Button>
						{/snippet}
					</EmptyState>
				</div>
			{:else if !thread}
				<div class="flex flex-1 items-center justify-center p-6"><Spinner label="Opening conversation" /></div>
			{:else}
				<div class="flex-1 overflow-auto">
					<header class="border-b border-[var(--border-color)] px-5 py-4">
						<div class="flex items-center gap-2">
							<button
								type="button"
								class="inline-flex size-7 items-center justify-center rounded-[var(--radius-inner)] text-[var(--muted-fg)] hover:bg-[var(--surface-2)] hover:text-foreground md:hidden"
								aria-label="Back to conversations"
								onclick={() => {
									readVersion++;
									selected = '';
									thread = null;
								}}
							>
								<ArrowLeftIcon class="size-4" aria-hidden="true" />
							</button>
							<span class="text-[12px] text-[var(--muted-fg)]">{plural(thread.messageCount, 'message')}</span>
							{#if readLoading}<Spinner size={12} label="Refreshing conversation" />{/if}
						</div>
						<h2 class="mt-1 text-[16px] font-medium tracking-[-0.01em] text-foreground">{thread.subject || '(No subject)'}</h2>
						<div class="mt-3 flex flex-wrap gap-2">
							{#each threadActions(thread.labels, { quarantined: folder === 'quarantined' }) as action (action.key)}
								{@const Icon = actionIcons[action.key]}
								<Button variant="outline" size="sm" disabled={actionBusy !== ''} onclick={() => applyLabels(action)}>
									<Icon class="size-3.5" aria-hidden="true" />
									{action.label}
								</Button>
							{/each}
						</div>
					</header>
					{#each thread.messages as message (message.messageId)}
						<MessageCard {message} onRelease={release} onAttachment={download} />
					{/each}
				</div>
				{#if target}
					{#key target.messageId}
						<ReplyBox {inboxId} message={target} onSent={replied} />
					{/key}
				{/if}
			{/if}
		</section>
	</div>
</div>

{#snippet listFailure()}
	<div class="p-3">
		<InlineAlert tone="danger" title="Could not load mail">
			{listError}
			{#snippet actions()}
				<Button variant="secondary" size="sm" onclick={() => loadThreads()}>Try again</Button>
			{/snippet}
		</InlineAlert>
	</div>
{/snippet}
