<script lang="ts">
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { Button } from '$lib/components/ds/button';
	import { InlineAlert } from '$lib/components/ds/patterns';
	import FallbackAvatar from '$lib/components/FallbackAvatar.svelte';
	import { messageTime } from '$lib/services/format';
	import { deliveryLines, protectionLines, triageDetails } from '$lib/services/mail';
	import type { Attachment, Message } from '$lib/services/types';
	import TriageBadges from './TriageBadges.svelte';

	let {
		message,
		onRelease,
		onAttachment
	}: {
		message: Message;
		onRelease?: (message: Message) => Promise<void>;
		onAttachment: (message: Message, attachment: Attachment) => Promise<void>;
	} = $props();

	let busy = $state('');
	const quarantined = $derived(message.protection?.status === 'quarantined');

	async function run(key: string, task: () => Promise<void>) {
		if (busy) return;
		busy = key;
		try {
			await task();
		} finally {
			busy = '';
		}
	}

	const details = $derived(
		[
			message.triage ? { label: 'Email triage', lines: triageDetails(message.triage) } : null,
			message.delivery ? { label: 'Delivery details', lines: deliveryLines(message.delivery) } : null,
			message.protection ? { label: 'Protection checks', lines: protectionLines(message.protection) } : null
		].filter((item): item is { label: string; lines: string[] } => item !== null)
	);
</script>

<article class="border-b border-[var(--border-color)] px-5 py-4 last:border-b-0" data-message-id={message.messageId}>
	<header class="flex items-start gap-3">
		<FallbackAvatar name={message.from} size={28} class="mt-0.5 h-7 w-7 shrink-0" />
		<div class="min-w-0 flex-1">
			<p class="truncate text-[13px] font-medium text-foreground">{message.from}</p>
			<p class="truncate text-[12px] text-[var(--muted-fg)]">
				To: {message.to.join(', ')}{message.cc?.length ? ` · Cc: ${message.cc.join(', ')}` : ''}
			</p>
		</div>
		<time class="shrink-0 text-[12px] text-[var(--muted-fg)]" datetime={message.timestamp}>{messageTime(message.timestamp)}</time>
	</header>

	{#if message.triage}<div class="mt-2.5 pl-10"><TriageBadges triage={message.triage} /></div>{/if}

	{#if quarantined}
		<InlineAlert tone="warning" title="This message is quarantined" class="mt-3 ml-10">
			Review its checks before releasing it.
			{#snippet actions()}
				{#if onRelease && message.protection?.antivirus?.status === 'clean'}
					<Button size="sm" variant="outline" disabled={busy !== ''} onclick={() => run('release', () => onRelease(message))}>
						{busy === 'release' ? 'Releasing…' : 'Release message'}
					</Button>
				{/if}
			{/snippet}
		</InlineAlert>
	{/if}

	<div class="mt-3 pl-10 text-[13px] leading-[1.6] whitespace-pre-wrap text-foreground">
		{message.text ?? 'Message body is held for owner review.'}
	</div>

	{#if message.attachments?.length && !quarantined}
		<div class="mt-3 flex flex-wrap gap-2 pl-10">
			{#each message.attachments as attachment (attachment.attachmentId)}
				<Button
					size="sm"
					variant="outline"
					disabled={busy !== ''}
					onclick={() => run(attachment.attachmentId, () => onAttachment(message, attachment))}
				>
					<DownloadIcon class="size-3.5" aria-hidden="true" />
					{attachment.filename} · {Math.ceil(attachment.size / 1024)} KB
				</Button>
			{/each}
		</div>
	{/if}

	{#if details.length}
		<div class="mt-3 space-y-1.5 pl-10">
			{#each details as item (item.label)}
				<details class="group rounded-[var(--radius-inner)] text-[12px] text-[var(--muted-fg)]">
					<summary class="cursor-pointer select-none py-0.5 transition-colors duration-150 hover:text-foreground">{item.label}</summary>
					<ul class="mt-1.5 space-y-1 rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)] px-3.5 py-2.5 leading-[1.5]">
						{#each item.lines as line, index (index)}<li>{line}</li>{/each}
					</ul>
				</details>
			{/each}
		</div>
	{/if}
</article>
