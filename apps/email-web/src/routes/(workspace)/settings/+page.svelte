<script lang="ts">
	import { goto } from '$app/navigation';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ds/button';
	import { Input } from '$lib/components/ds/input';
	import { FormField, InlineAlert, SectionHeader, ToggleRow } from '$lib/components/ds/patterns';
	import { Skeleton } from '$lib/components/ds/skeleton';
	import PageShell from '$lib/components/PageShell.svelte';
	import { staleApiError, staleSettingsMessage } from '$lib/services/billing';
	import type { Customer } from '$lib/services/types';
	import { useWorkspace } from '$lib/workspace.svelte';

	type FormKey = 'organization' | 'profile' | 'notifications';
	const saved: Record<FormKey, string> = {
		organization: 'Organization name saved.',
		profile: 'Profile name saved.',
		notifications: 'Notification preferences saved.'
	};

	const workspace = useWorkspace();

	let customer = $state<Customer | null>(null);
	let organizationName = $state('');
	let displayName = $state('');
	let desktopNotifications = $state(false);
	let emailNotifications = $state(false);
	let pending = $state<FormKey | null>(null);
	let status = $state<Partial<Record<FormKey, string>>>({});
	let error = $state('');
	let permission = $state<NotificationPermission | 'unsupported'>('unsupported');
	let version = 0;

	const values = $derived({
		organization: { organizationName: organizationName.trim() },
		profile: { displayName: displayName.trim() },
		notifications: { desktopNotifications, emailNotifications }
	});
	const changed = (form: FormKey) =>
		Boolean(customer) &&
		Object.entries(values[form]).some(([key, value]) => value !== (customer?.[key as keyof Customer] ?? (typeof value === 'boolean' ? false : '')));

	function fill(value: Customer, only: FormKey | null = null) {
		customer = value;
		if (!only || only === 'organization') organizationName = value.organizationName ?? '';
		if (!only || only === 'profile') displayName = value.displayName ?? '';
		if (!only || only === 'notifications') {
			desktopNotifications = value.desktopNotifications ?? false;
			emailNotifications = value.emailNotifications ?? false;
		}
	}

	const readPermission = () => (permission = 'Notification' in window ? Notification.permission : 'unsupported');

	// The session already carries this account, so the page paints at once and then refreshes.
	async function load() {
		const requestVersion = ++version;
		error = '';
		if (workspace.customer) fill(workspace.customer);
		try {
			const result = await workspace.rpc<{ customer: Customer }>('getSettings');
			if (requestVersion !== version) return;
			fill(result.customer);
			workspace.updateCustomer(result.customer);
		} catch (reason) {
			if (requestVersion === version) error = staleApiError(reason, staleSettingsMessage, 'Settings request failed');
		}
	}

	onMount(() => {
		if (!workspace.isCustomer) return void goto('/inboxes', { replaceState: true });
		readPermission();
		window.addEventListener('focus', readPermission);
		void load();
		return () => window.removeEventListener('focus', readPermission);
	});

	async function save(form: FormKey, event: SubmitEvent) {
		event.preventDefault();
		if (pending || !customer) return;
		if (form === 'organization' && !organizationName.trim()) return (error = 'Enter an organization name.');
		if (form === 'profile' && !displayName.trim()) return (error = 'Enter your name.');
		const requestVersion = version;
		pending = form;
		status = {};
		error = '';
		try {
			const result = await workspace.rpc<{ customer: Customer }>('updateSettings', values[form]);
			if (requestVersion !== version) return;
			fill(result.customer, form);
			customer = result.customer;
			workspace.updateCustomer(result.customer);
			status = { [form]: saved[form] };
		} catch (reason) {
			if (requestVersion === version) error = staleApiError(reason, staleSettingsMessage, 'Settings request failed');
		} finally {
			if (requestVersion === version) pending = null;
		}
	}

	async function allowNotifications() {
		try {
			await Notification.requestPermission();
		} finally {
			readPermission();
		}
	}

	const permissionText = $derived(
		{
			granted: 'This browser can show desktop notifications.',
			denied: 'Notifications are blocked. Allow them in your browser’s site settings.',
			default: 'Allow notifications in this browser to receive desktop alerts.',
			unsupported: 'This browser does not support desktop notifications.'
		}[permission]
	);

	const cardClass = 'rounded-[var(--radius-card)] border border-[var(--ds-border)] bg-[var(--surface)]';
	const footerClass = 'flex items-center justify-between gap-3 border-t border-[var(--ds-border)] px-4 py-3';
</script>

<svelte:head>
	<title>Settings · Goshen Email</title>
</svelte:head>

{#snippet footer(form: FormKey)}
	<footer class={footerClass}>
		<span class="text-[12px] text-[var(--status-success-fg)]" role="status">{status[form] ?? ''}</span>
		<Button type="submit" disabled={pending !== null || !changed(form)}>{pending === form ? 'Saving…' : 'Save changes'}</Button>
	</footer>
{/snippet}

<PageShell title="Settings" description="Make this workspace yours.">
	<div class="mt-3 max-w-2xl space-y-4">
		{#if error}<InlineAlert tone="danger">{error}{#snippet actions()}<Button variant="secondary" size="sm" onclick={load}>Try again</Button>{/snippet}</InlineAlert>{/if}
		{#if !customer}
			<Skeleton class="h-32 w-full" />
		{:else}
			<form class={cardClass} onsubmit={(event) => save('organization', event)}>
				<fieldset disabled={pending !== null} class="space-y-3 p-4">
					<SectionHeader title="Organization" description="Give your workspace a name your team will recognize." />
					<FormField label="Organization name" for="organization-name" hint="Shown in the sidebar under your name.">
						<Input id="organization-name" bind:value={organizationName} required maxlength={100} autocomplete="organization" />
					</FormField>
				</fieldset>
				{@render footer('organization')}
			</form>

			<form class={cardClass} onsubmit={(event) => save('profile', event)}>
				<fieldset disabled={pending !== null} class="space-y-3 p-4">
					<SectionHeader title="Your profile" description="Manage how your name appears in Goshen Email." />
					<FormField label="Full name" for="profile-name">
						<Input id="profile-name" bind:value={displayName} required maxlength={200} autocomplete="name" />
					</FormField>
					<FormField label="Sign-in email" for="settings-email" hint="This is the verified email address for your account.">
						<Input id="settings-email" type="email" value={customer.email} readonly />
					</FormField>
				</fieldset>
				{@render footer('profile')}
			</form>

			<form class={cardClass} onsubmit={(event) => save('notifications', event)}>
				<fieldset disabled={pending !== null} class="space-y-3 p-4">
					<SectionHeader title="Notifications" description="Choose how you hear about new mail in your inboxes." />
					<ToggleRow
						label="Desktop notifications"
						description="Show alerts while Goshen Email is open. Message contents stay private."
						bind:checked={desktopNotifications}
					/>
					<div class="flex flex-wrap items-center gap-2 px-1">
						<p class="text-[12px] text-[var(--muted-fg)]" role="status">{permissionText}</p>
						{#if permission === 'default'}
							<Button size="sm" variant="secondary" onclick={allowNotifications}>Allow in this browser</Button>
						{/if}
					</div>
					<ToggleRow
						label="Email notifications"
						description={`Get a summary of new arrivals, grouped each minute, at ${customer.email}.`}
						bind:checked={emailNotifications}
					/>
					<p class="px-1 text-[12px] text-[var(--muted-fg)]">Applies to new mail after you enable notifications. Quarantined mail is excluded.</p>
				</fieldset>
				{@render footer('notifications')}
			</form>

			<section class="{cardClass} space-y-2 p-4">
				<SectionHeader
					title="Account access"
					description={workspace.session?.authMode === 'access'
						? 'Sign in with an email code through Cloudflare Access.'
						: 'Sign in with an email link or a one-time code.'}
				/>
				<a href="/api-keys" class="inline-flex items-center gap-1 text-[13px] text-[var(--accent-text)] hover:text-foreground">
					Manage API keys <ArrowRightIcon class="size-3.5" aria-hidden="true" />
				</a>
			</section>
		{/if}
	</div>
</PageShell>
