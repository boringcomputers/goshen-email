<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ds/button';
	import { InlineAlert } from '$lib/components/ds/patterns';
	import { api } from '$lib/workspace.svelte';

	// The link carries its token in the fragment, which never reaches a server log. It waits in
	// sessionStorage for ten minutes so a reload before confirming still works.
	const storageKey = 'bezalel-link';
	let confirmation = $state<{ token: string; email: string } | null>(null);
	let ready = $state(false);
	let busy = $state(false);
	let error = $state('');

	onMount(() => {
		const fragment = new URLSearchParams(location.hash.slice(1));
		try {
			if (fragment.has('token'))
				sessionStorage.setItem(
					storageKey,
					JSON.stringify({ token: fragment.get('token'), email: fragment.get('email'), expires: Date.now() + 600_000 })
				);
			const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
			if (saved && saved.expires > Date.now() && saved.email && /^[A-Za-z0-9_-]{20,256}$/.test(saved.token ?? ''))
				confirmation = { token: saved.token, email: saved.email };
			else sessionStorage.removeItem(storageKey);
		} catch {
			confirmation = null;
		}
		history.replaceState(null, '', '/magic-link');
		ready = true;
	});

	async function confirm() {
		if (!confirmation || busy) return;
		busy = true;
		error = '';
		try {
			await api.auth('magic-link/verify', { token: confirmation.token, email: confirmation.email });
			sessionStorage.removeItem(storageKey);
			await goto('/', { replaceState: true });
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'Could not connect. Please try again.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Confirm sign-in · Goshen Email</title>
</svelte:head>

<div class="flex min-h-dvh items-center justify-center bg-[var(--bg)] p-6">
	<div class="w-full max-w-xs">
		<h1 class="text-[14px] font-semibold tracking-[-0.01em] text-foreground">Goshen Email</h1>
		{#if !ready}
			<p class="mt-1.5 text-[13px] text-[var(--muted-fg)]">Reading your sign-in link…</p>
		{:else if confirmation}
			<p class="mt-1.5 text-[13px] text-[var(--muted-fg)]">
				Sign in as {confirmation.email}. Continue only if this is your email address.
			</p>
			{#if error}<p class="mt-3 text-[12px] text-[var(--status-danger-fg)]" role="alert">{error}</p>{/if}
			<Button class="mt-4 w-full" onclick={confirm} disabled={busy}>{busy ? 'Signing in…' : 'Continue to workspace'}</Button>
		{:else}
			<InlineAlert tone="warning" class="mt-3">This sign-in link is incomplete. Request a new email to continue.</InlineAlert>
			<Button variant="secondary" class="mt-3 w-full" href="/sign-in">Back to sign in</Button>
		{/if}
	</div>
</div>
