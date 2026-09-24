<script lang="ts">
	import { goto } from '$app/navigation';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ds/badge';
	import { Button } from '$lib/components/ds/button';
	import { Input } from '$lib/components/ds/input';
	import { EmptyState, InlineAlert } from '$lib/components/ds/patterns';
	import { Select } from '$lib/components/ds/select';
	import { Spinner } from '$lib/components/ds/spinner';
	import MessageCard from '$lib/components/mail/MessageCard.svelte';
	import ThreadList from '$lib/components/mail/ThreadList.svelte';
	import { ApiError } from '$lib/services/dashboard-api';
	import { filterInboxes, mergeThreads, safeDownloadUrl, threadItems } from '$lib/services/mail';
	import type { Attachment, Inbox, Message, Thread, ThreadSummary } from '$lib/services/types';
	import { useWorkspace } from '$lib/workspace.svelte';

	// The dashboard checks that attachment links point at the configured native Worker before
	// they reach the browser; this page only confirms the path and protocol.
	const nativeFolders = [
		{ value: 'all', label: 'All mail' },
		{ value: 'received', label: 'Inbox' },
		{ value: 'sent', label: 'Sent' },
		{ value: 'trash', label: 'Trash' }
	];

	const workspace = useWorkspace();

	let inboxes = $state<Inbox[] | null>(null);
	let search = $state('');
	let error = $state('');
	let inbox = $state('');
	let folder = $state('all');
	let query = $state('');
	let threads = $state<ThreadSummary[]>([]);
	let nextPage = $state<string | undefined>();
	let listLoading = $state(false);
	let selected = $state('');
	let thread = $state<Thread | null>(null);
	let large = $state<{ subject: string; messages: Message[]; pageToken?: string; scanning: boolean; note: string } | null>(null);
	let readLoading = $state(false);
	let inventoryVersion = 0, listVersion = 0, readVersion = 0;

	const visible = $derived(filterInboxes(inboxes ?? [], search, ''));

	async function run(task: () => Promise<void>) {
		error = '';
		try {
			await task();
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'The Bezalel request failed.';
		}
	}

	function clearReader() {
		readVersion++;
		selected = '';
		thread = null;
		large = null;
	}

	async function loadInventory() {
		const version = ++inventoryVersion;
		listVersion++;
		clearReader();
		inbox = '';
		const result = await workspace.nativeRpc<{ inboxes: Inbox[] }>('listInboxes', {});
		if (version === inventoryVersion) inboxes = result.inboxes;
	}

	onMount(() => {
		if (workspace.session?.nativeMailEnabled !== true) void goto('/inboxes', { replaceState: true });
		else void run(loadInventory);
	});

	async function openInbox(address: string) {
		listVersion++;
		clearReader();
		inbox = address;
		query = '';
		folder = 'all';
		await loadThreads();
	}

	async function loadThreads(append = false) {
		const version = ++listVersion, target = inbox;
		if (!target) return;
		if (!append) {
			threads = [];
			nextPage = undefined;
			clearReader();
		}
		listLoading = true;
		try {
			const search = query.trim();
			const result = await workspace.nativeRpc<{ threads?: ThreadSummary[]; messages?: ThreadSummary[]; nextPageToken?: string }>(
				search ? 'searchMessages' : 'listThreads',
				{
					inboxId: target,
					limit: 30,
					...(append && nextPage ? { pageToken: nextPage } : {}),
					...(search ? { query: search } : { includeTrash: folder === 'trash', ...(folder === 'all' ? {} : { labels: [folder] }) })
				}
			);
			if (version !== listVersion || target !== inbox) return;
			threads = mergeThreads(append ? threads : [], threadItems(result));
			nextPage = result.nextPageToken;
		} finally {
			if (version === listVersion) listLoading = false;
		}
	}

	async function readThread(threadId: string) {
		const version = ++readVersion, target = inbox;
		selected = threadId;
		thread = null;
		large = null;
		readLoading = true;
		try {
			const result = await workspace.nativeRpc<Thread>('getThread', { inboxId: target, threadId, includeBodies: true });
			if (version === readVersion && target === inbox) thread = result;
		} catch (failure) {
			if (version !== readVersion || target !== inbox) return;
			if (failure instanceof ApiError && failure.status === 413) {
				large = { subject: threads.find((item) => item.threadId === threadId)?.subject || '(No subject)', messages: [], scanning: false, note: '' };
				await loadLargePage(threadId, version, target);
			} else throw failure;
		} finally {
			if (version === readVersion) readLoading = false;
		}
	}

	// The list API pages the whole inbox; pick out this thread's messages without fetching unrelated bodies.
	async function loadLargePage(threadId: string, version = readVersion, target = inbox) {
		const current = large;
		if (!current || current.scanning) return;
		current.scanning = true;
		current.note = '';
		try {
			let added = 0;
			const seen = new Set(current.messages.map((message) => message.messageId));
			for (let scanned = 0; scanned < 3; scanned++) {
				const result = await workspace.nativeRpc<{ messages: Message[]; nextPageToken?: string }>('listMessages', {
					inboxId: target,
					limit: 100,
					...(current.pageToken ? { pageToken: current.pageToken } : {})
				});
				if (version !== readVersion || target !== inbox) return;
				for (const message of result.messages)
					if (message.threadId === threadId && !seen.has(message.messageId)) {
						seen.add(message.messageId);
						current.messages.push(message);
						added++;
					}
				current.pageToken = result.nextPageToken;
				if (added || !current.pageToken) break;
			}
			if (!added && current.pageToken) current.note = 'Still looking for older messages. Select Load more messages to continue.';
			if (!current.messages.length && !current.pageToken) current.note = 'No messages found in this conversation.';
		} finally {
			current.scanning = false;
		}
	}

	async function openMessage(message: Message) {
		const version = readVersion, target = inbox;
		const body = await workspace.nativeRpc<Message>('getMessage', { inboxId: target, messageId: message.messageId });
		if (version !== readVersion || target !== inbox || !large) return;
		large.messages = large.messages.map((item) => (item.messageId === message.messageId ? body : item));
	}

	async function download(message: Message, attachment: Attachment) {
		const version = readVersion, target = inbox;
		await run(async () => {
			const result = await workspace.nativeRpc<{ downloadUrl: string }>('getAttachment', {
				inboxId: target,
				messageId: message.messageId,
				attachmentId: attachment.attachmentId
			});
			if (version !== readVersion || target !== inbox) return;
			const link = document.createElement('a');
			link.href = safeDownloadUrl(result.downloadUrl, { pathPrefix: '/attachments/' });
			link.rel = 'noreferrer noopener';
			link.target = '_blank';
			link.click();
		});
	}

	const headClass = 'border-b border-[var(--ds-border)] px-4 py-2.5 text-left text-[11px] font-medium uppercase text-[var(--muted-fg)]';
	const cellClass = 'border-b border-[var(--ds-border)] px-4 py-3';
</script>

<svelte:head>
	<title>Bezalel inboxes · Goshen Email</title>
</svelte:head>

<div class="flex h-full flex-col px-5 py-4">
	<header class="mb-3 flex items-start justify-between gap-4">
		<div class="min-w-0">
			{#if inbox}
				<button type="button" class="mb-1 inline-flex items-center gap-1 text-[12px] text-[var(--muted-fg)] hover:text-foreground" onclick={() => run(loadInventory)}>
					<ArrowLeftIcon class="size-3.5" aria-hidden="true" /> All Bezalel inboxes
				</button>
				<h1 class="truncate text-[16px] font-medium tracking-[-0.01em] text-foreground">{inbox}</h1>
			{:else}
				<h1 class="text-[16px] font-medium tracking-[-0.01em] text-foreground">Bezalel inboxes</h1>
				<p class="mt-1 text-[13px] text-[var(--muted-fg)]">
					Read mail across Bezalel's existing inboxes. This admin view keeps each inbox's owner and leaves messages unchanged.
				</p>
			{/if}
		</div>
		<Badge variant="secondary">Read only</Badge>
	</header>

	{#if error}<InlineAlert tone="danger" class="mb-3">{error}</InlineAlert>{/if}

	{#if !inbox}
		<div class="mb-3 flex items-center gap-2">
			<div class="relative w-full max-w-xs">
				<SearchIcon class="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[var(--muted-fg)]" aria-hidden="true" />
				<Input type="search" bind:value={search} class="py-2 pl-8" placeholder="Search inboxes…" aria-label="Search Bezalel inboxes" />
			</div>
			<Button variant="ghost" size="icon" class="ml-auto" aria-label="Refresh Bezalel inboxes" onclick={() => run(loadInventory)}>
				<RefreshCwIcon aria-hidden="true" />
			</Button>
		</div>
		<div class="min-h-0 flex-1 overflow-auto rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)]">
			{#if inboxes === null}
				<div class="flex justify-center p-6"><Spinner label="Loading Bezalel inboxes" /></div>
			{:else}
				<table class="w-full border-collapse text-[13px]">
					<thead>
						<tr>
							<th scope="col" class={headClass}>Inbox</th>
							<th scope="col" class={headClass}>Address</th>
							<th scope="col" class={headClass}><span class="sr-only">Open inbox</span></th>
						</tr>
					</thead>
					<tbody>
						{#each visible as item (item.inboxId)}
							<tr class="[&:last-child>td]:border-b-0">
								<td class="{cellClass} font-medium text-foreground">{item.displayName || item.inboxId}</td>
								<td class="{cellClass} text-[var(--muted-fg)]">{item.address || item.inboxId}</td>
								<td class="{cellClass} text-right">
									<Button size="sm" variant="outline" onclick={() => run(() => openInbox(item.inboxId))}>Open</Button>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="3" class="px-4 py-8 text-center text-[13px] text-[var(--muted-fg)]">
									{inboxes.length ? 'No inboxes match this search.' : 'No active Bezalel inboxes.'}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
		{#if inboxes}
			<p class="mt-3 text-[12px] text-[var(--muted-fg)]" role="status">{visible.length} inbox{visible.length === 1 ? '' : 'es'}</p>
		{/if}
	{:else}
		<div class="grid min-h-0 flex-1 overflow-hidden rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)] md:grid-cols-[340px_1fr]">
			<section class="min-h-0 flex-col border-r border-[var(--border-color)] {selected ? 'hidden md:flex' : 'flex'}" aria-label="Conversations">
				<form
					class="space-y-2 border-b border-[var(--border-color)] p-2.5"
					role="search"
					onsubmit={(event) => {
						event.preventDefault();
						void run(() => loadThreads());
					}}
				>
					<Input type="search" bind:value={query} maxlength={1000} class="py-2 text-[12px]" placeholder="Search all messages in this inbox…" aria-label="Search messages in this inbox" />
					<Select
						ariaLabel="Bezalel mail folder"
						class="py-2 text-[12px]"
						value={folder}
						options={nativeFolders}
						onValueChange={(value) => {
							folder = value;
							query = '';
							void run(() => loadThreads());
						}}
					/>
				</form>
				<ThreadList
					{threads}
					{selected}
					loading={listLoading}
					more={Boolean(nextPage)}
					emptyTitle="No conversations found."
					emptyDescription="Try another folder or search."
					onSelect={(threadId) => run(() => readThread(threadId))}
					onMore={() => run(() => loadThreads(true))}
				/>
			</section>
			<section class="min-h-0 flex-col overflow-auto {selected ? 'flex' : 'hidden md:flex'}" aria-label="Conversation">
				{#if !selected}
					<div class="flex flex-1 items-center justify-center p-6">
						<EmptyState title="Choose a conversation" description="Select a conversation to read its messages." class="w-full max-w-sm" />
					</div>
				{:else if readLoading && !large}
					<div class="flex flex-1 items-center justify-center p-6"><Spinner label="Loading conversation" /></div>
				{:else if thread}
					<header class="border-b border-[var(--border-color)] px-5 py-4">
						<h2 class="text-[16px] font-medium tracking-[-0.01em] text-foreground">{thread.subject || '(No subject)'}</h2>
					</header>
					{#each thread.messages as message (message.messageId)}
						<MessageCard {message} onAttachment={download} />
					{/each}
				{:else if large}
					<header class="border-b border-[var(--border-color)] px-5 py-4">
						<h2 class="text-[16px] font-medium tracking-[-0.01em] text-foreground">{large.subject}</h2>
						<p class="mt-1 text-[12px] text-[var(--muted-fg)]">This conversation is large. Open individual messages below.</p>
					</header>
					{#each large.messages as message (message.messageId)}
						{#if message.text === undefined}
							<article class="border-b border-[var(--border-color)] px-5 py-4">
								<p class="text-[13px] font-medium text-foreground">{message.from}</p>
								<p class="text-[12px] text-[var(--muted-fg)]">{message.preview || 'No preview'}</p>
								<Button size="sm" variant="outline" class="mt-2" onclick={() => run(() => openMessage(message))}>Read message</Button>
							</article>
						{:else}
							<MessageCard {message} onAttachment={download} />
						{/if}
					{/each}
					<div class="flex flex-col items-start gap-2 p-5">
						{#if large.note}<p class="text-[12px] text-[var(--muted-fg)]" role="status">{large.note}</p>{/if}
						{#if large.pageToken}
							<Button size="sm" variant="secondary" disabled={large.scanning} onclick={() => run(() => loadLargePage(selected))}>
								{large.scanning ? 'Loading…' : 'Load more messages'}
							</Button>
						{/if}
					</div>
				{:else}
					<div class="flex flex-1 items-center justify-center p-6">
						<EmptyState title="Could not open this conversation" description="Select it to try again." class="w-full max-w-sm" />
					</div>
				{/if}
			</section>
		</div>
	{/if}
</div>
