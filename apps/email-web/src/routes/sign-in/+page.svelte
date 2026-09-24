<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ds/button';
	import { Input } from '$lib/components/ds/input';
	import { FormField, InlineAlert, TabBar } from '$lib/components/ds/patterns';
	import { api, rememberReturnPath, safeReturnPath, takeReturnPath } from '$lib/workspace.svelte';
	import type { AuthMode } from '$lib/services/dashboard-api';

	type Method = 'code' | 'link';

	const signUp = $derived(page.url.searchParams.get('mode') === 'sign-up');
	const next = $derived(safeReturnPath(page.url.searchParams.get('next')) || '/');
	const reason = page.url.searchParams.get('reason');

	let authMode = $state<AuthMode | null>(null);
	let email = $state('');
	let name = $state('');
	let password = $state('');
	let code = $state('');
	let method = $state<Method>('code');
	let sent = $state(false);
	let busy = $state(false);
	let error = $state(reason === 'access_denied' ? 'This account does not have access to the dashboard.' : '');
	let notice = $state('');
	let resendAt = 0;

	onMount(async () => {
		try {
			const session = await api.session();
			if (session.authenticated) return void goto(next, { replaceState: true });
			authMode = session.authMode ?? 'password';
		} catch (failure) {
			authMode = 'account';
			error = failure instanceof Error ? failure.message : 'Could not connect. Please try again.';
		}
	});

	// The Worker resolves callbacks against its own public origin, so paths stay valid wherever this app runs.
	async function sendEmail() {
		await api.auth(method === 'code' ? 'email-otp/send-verification-otp' : 'sign-in/magic-link', {
			email,
			...(method === 'code' ? { type: 'sign-in' } : { ...(name ? { name } : {}), callbackURL: next, errorCallbackURL: '/sign-in' })
		});
		if (method === 'link') rememberReturnPath(next);
		sent = true;
		resendAt = Date.now() + 60_000;
		notice =
			method === 'link'
				? 'Open the link in your email to finish signing in. The link works once and expires in 10 minutes. Check your spam folder if you don’t see it.'
				: '';
		code = '';
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		busy = true;
		error = '';
		try {
			if (authMode === 'password') {
				await api.login(password);
				password = '';
				takeReturnPath();
				await goto(next, { replaceState: true });
			} else if (sent && method === 'code') {
				await api.auth('sign-in/email-otp', { email, otp: code.trim(), ...(name ? { name } : {}) });
				takeReturnPath();
				await goto(next, { replaceState: true });
			} else {
				email = email.trim();
				name = name.trim();
				await sendEmail();
			}
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'Could not connect. Please try again.';
		} finally {
			busy = false;
		}
	}

	async function resend() {
		if (busy) return;
		if (Date.now() < resendAt) {
			notice = 'Please wait a minute before requesting another email.';
			return;
		}
		busy = true;
		error = '';
		try {
			await sendEmail();
		} catch (failure) {
			notice = failure instanceof Error ? failure.message : 'Could not send the email. Please try again.';
		} finally {
			busy = false;
		}
	}

	function restart() {
		sent = false;
		code = '';
		notice = '';
		error = '';
	}

	const submitLabel = $derived(
		authMode === 'password'
			? 'Sign in'
			: sent && method === 'code'
				? 'Verify code and sign in'
				: method === 'code'
					? 'Email me a code'
					: 'Email me a sign-in link'
	);
</script>

<svelte:head>
	<title>{signUp ? 'Create an account' : 'Sign in'} · Goshen Email</title>
</svelte:head>

<div class="flex min-h-dvh items-center justify-center bg-[var(--bg)] p-6">
	<div class="w-full max-w-xs">
		<h1 class="text-[14px] font-semibold tracking-[-0.01em] text-foreground">Goshen Email</h1>
		{#if authMode === null}
			<p class="mt-1.5 text-[13px] text-[var(--muted-fg)]">Checking your session…</p>
		{:else if authMode === 'access'}
			<p class="mt-1.5 text-[13px] text-[var(--muted-fg)]">
				Use your invited email address to sign in through Cloudflare Access.
			</p>
			<Button class="mt-4 w-full" href="/cdn-cgi/access/logout">Sign in with another account</Button>
		{:else}
			<p class="mt-1.5 text-[13px] text-[var(--muted-fg)]">
				{#if authMode === 'password'}
					Enter the dashboard password to continue.
				{:else if sent}
					We sent {method === 'code' ? 'a six-digit code' : 'a sign-in link'} to {email}.
				{:else if signUp}
					Create an account to give your agents their own inboxes.
				{:else}
					Sign in to manage your agents' inboxes, keys, and domains.
				{/if}
			</p>

			{#if !(sent && method === 'link')}
				<form class="mt-4 space-y-3" onsubmit={submit}>
					{#if authMode === 'password'}
						<Input
							type="password"
							bind:value={password}
							placeholder="Password"
							autocomplete="current-password"
							aria-label="Dashboard password"
							required
						/>
					{:else if !sent}
						{#if signUp}
							<FormField label="Name" for="name">
								<Input id="name" bind:value={name} autocomplete="name" maxlength={200} required />
							</FormField>
						{/if}
						<FormField label="Email address" for="email">
							<Input id="email" type="email" bind:value={email} autocomplete="email" maxlength={254} required />
						</FormField>
						<TabBar
							variant="segmented"
							class="w-full"
							tabs={[
								{ key: 'code', label: 'Email code' },
								{ key: 'link', label: 'Magic link' }
							]}
							active={method}
							onChange={(key) => (method = key as Method)}
						/>
					{:else}
						<FormField label="Six-digit code" for="code" hint="Use the latest code from your email. It expires in 10 minutes.">
							<Input
								id="code"
								bind:value={code}
								inputmode="numeric"
								autocomplete="one-time-code"
								pattern={'[0-9]{6}'}
								maxlength={6}
								required
							/>
						</FormField>
					{/if}
					{#if error}<p class="text-[12px] text-[var(--status-danger-fg)]" role="alert">{error}</p>{/if}
					<Button type="submit" class="w-full" disabled={busy}>{busy ? 'Working…' : submitLabel}</Button>
				</form>
			{:else if error}
				<p class="mt-3 text-[12px] text-[var(--status-danger-fg)]" role="alert">{error}</p>
			{/if}

			{#if notice}
				<InlineAlert tone="info" class="mt-3">{notice}</InlineAlert>
			{/if}

			{#if sent}
				<div class="mt-3 flex flex-col gap-2">
					<Button variant="secondary" class="w-full" onclick={resend} disabled={busy}>Send another email</Button>
					<Button variant="ghost" class="w-full" onclick={restart}>Use a different email or method</Button>
				</div>
			{:else if authMode === 'account'}
				<p class="mt-4 text-[12px] text-[var(--muted-fg)]">
					{#if signUp}
						Already have an account? <a class="text-foreground underline-offset-4 hover:underline" href="/sign-in">Sign in</a>
					{:else}
						New to Goshen Email? <a class="text-foreground underline-offset-4 hover:underline" href="/sign-in?mode=sign-up">Create an account</a>
					{/if}
				</p>
			{/if}
		{/if}
	</div>
</div>
