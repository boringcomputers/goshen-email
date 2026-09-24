<script lang="ts">
	import { goto } from '$app/navigation';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CodeXmlIcon from '@lucide/svelte/icons/code-xml';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ds/button';
	import PageShell from '$lib/components/PageShell.svelte';
	import { useWorkspace } from '$lib/workspace.svelte';

	const workspace = useWorkspace();
	const apiUrl = $derived(workspace.session?.apiUrl ?? '');

	onMount(() => {
		if (!workspace.isCustomer) void goto('/inboxes', { replaceState: true });
	});

	const cards = $derived([
		{
			icon: CodeXmlIcon,
			title: 'REST API',
			body: 'Create inboxes, read mail, and send messages from your application.',
			label: 'API URL',
			value: apiUrl || 'API URL is not configured',
			link: apiUrl ? { href: `${apiUrl}/openapi.json`, text: 'View API specification' } : null
		},
		{
			icon: LayersIcon,
			title: 'MCP',
			body: 'Give an MCP client access to your email tools. Connect with an account API key.',
			label: 'Server URL',
			value: apiUrl ? `${apiUrl}/mcp` : 'MCP URL is not configured',
			link: null
		},
		{
			icon: TerminalIcon,
			title: 'SDKs & CLI',
			body: 'Use the TypeScript SDK, Python SDK, or CLI to work with your inboxes and named groups.',
			label: '',
			value: '',
			link: { href: 'https://goshenemail.com/docs', text: 'Setup and examples' }
		}
	]);
</script>

<svelte:head>
	<title>Integrations · Goshen Email</title>
</svelte:head>

<PageShell title="Integrations" description="One account key. All your inboxes.">
	{#snippet actions()}
		<Button variant="outline" href="/api-keys">Manage API keys <ArrowRightIcon aria-hidden="true" /></Button>
	{/snippet}

	<div class="mt-3 grid gap-3 md:grid-cols-3">
		{#each cards as card (card.title)}
			{@const Icon = card.icon}
			<section class="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)] p-4">
				<span class="flex size-8 items-center justify-center rounded-[8px] border border-[var(--ds-border)] bg-[var(--surface-2)] text-[var(--muted-fg)]">
					<Icon class="size-4" aria-hidden="true" />
				</span>
				<h2 class="mt-1 text-[14px] font-medium tracking-[-0.01em] text-foreground">{card.title}</h2>
				<p class="text-[13px] text-[var(--muted-fg)]">{card.body}</p>
				{#if card.label}
					<div class="mt-1">
						<span class="block text-[11px] font-medium uppercase tracking-[0.01em] text-[var(--muted-fg)]">{card.label}</span>
						<code class="mt-1 block truncate rounded-[var(--radius-inner)] bg-[var(--surface-2)] px-2 py-1.5 font-mono text-[12px] text-foreground" title={card.value}>{card.value}</code>
					</div>
				{/if}
				{#if card.link}
					<a
						href={card.link.href}
						target="_blank"
						rel="noopener"
						class="mt-auto inline-flex items-center gap-1 pt-2 text-[13px] text-[var(--accent-text)] hover:text-foreground"
					>
						{card.link.text} <ArrowRightIcon class="size-3.5" aria-hidden="true" />
					</a>
				{/if}
			</section>
		{/each}
	</div>
</PageShell>
