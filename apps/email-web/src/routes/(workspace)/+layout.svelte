<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import * as DropdownMenu from '$lib/components/ds/dropdown-menu/index.js';
	import { Spinner } from '$lib/components/ds/spinner';
	import FallbackAvatar from '$lib/components/FallbackAvatar.svelte';
	import ComposeDialog from '$lib/components/mail/ComposeDialog.svelte';
	import CreateInboxDialog from '$lib/components/inbox/CreateInboxDialog.svelte';
	import CredentialsDialog from '$lib/components/inbox/CredentialsDialog.svelte';
	import DeleteInboxDialog from '$lib/components/inbox/DeleteInboxDialog.svelte';
	import { applyTheme, detectTheme, THEME_OPTIONS, type ThemeId } from '$lib/config/theme';
	import { provideDashboardLayoutState } from '$lib/layout-state.svelte';
	import { createDesktopNotifications } from '$lib/services/notifications';
	import { provideWorkspace, safeReturnPath } from '$lib/workspace.svelte';

	let { children } = $props();

	const workspace = provideWorkspace();
	const layoutState = provideDashboardLayoutState();
	let ready = $state(false);

	const notifications = createDesktopNotifications({
		rpc: (operation, input) => workspace.rpc(operation, input),
		openInbox: (inboxId) => void goto(`/inboxes/${encodeURIComponent(inboxId)}`)
	});
	$effect(() => {
		if (workspace.customer) notifications.start(workspace.customer);
		else notifications.reset();
	});
	$effect(() => () => notifications.reset());

	onMount(() => {
		let active = true;
		void (async () => {
			try {
				if (!(await workspace.start())) {
					const next = safeReturnPath(`${page.url.pathname}${page.url.search}`);
					return void goto(`/sign-in${next && next !== '/inboxes' ? `?next=${encodeURIComponent(next)}` : ''}`, { replaceState: true });
				}
				await workspace.loadInboxes(page.params.inboxId).catch(() => {});
			} catch (error) {
				toast.error(error instanceof Error ? error.message : 'Could not load your workspace.');
			} finally {
				if (active) ready = workspace.session !== null;
			}
		})();
		return () => {
			active = false;
		};
	});

	const sidebarCollapsedStorageKey = 'sidebar-collapsed';
	let sidebarCollapsed = $state(localStorage.getItem(sidebarCollapsedStorageKey) === 'true');
	function toggleSidebarCollapse() {
		sidebarCollapsed = !sidebarCollapsed;
		localStorage.setItem(sidebarCollapsedStorageKey, String(sidebarCollapsed));
	}

	let currentTheme = $state<ThemeId>(detectTheme());
	function chooseTheme(theme: ThemeId) {
		currentTheme = theme;
		applyTheme(theme);
	}

	type NavItem = { href: string; label: string; icon: string; visible: boolean };
	const navItems = $derived<NavItem[]>(
		[
			{
				href: '/inboxes',
				label: 'Inboxes',
				icon: 'M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H6.911a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661z',
				visible: true
			},
			{
				href: '/domains',
				label: 'Domains',
				icon: 'M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418',
				visible: workspace.showDomains
			},
			{
				href: '/api-keys',
				label: 'API keys',
				icon: 'M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z',
				visible: workspace.isCustomer
			},
			{
				href: '/integrations',
				label: 'Integrations',
				icon: 'M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5',
				visible: workspace.isCustomer
			},
			{
				href: '/bezalel-inboxes',
				label: 'Bezalel inboxes',
				icon: 'M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z',
				visible: workspace.session?.nativeMailEnabled === true
			}
		].filter((item) => item.visible)
	);

	const userMenuItems = $derived(
		[
			{
				href: '/billing',
				label: 'Plan and usage',
				icon: 'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z'
			},
			{
				href: '/settings',
				label: 'Settings',
				icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z'
			}
		].filter(() => workspace.isCustomer)
	);

	function isActive(href: string) {
		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}

	const isMailPage = $derived(page.route.id === '/(workspace)/inboxes/[inboxId]' || page.route.id === '/(workspace)/bezalel-inboxes');
	const composeTarget = $derived(page.params.inboxId ?? workspace.currentInboxId);
	const userName = $derived(workspace.customer?.displayName || workspace.customer?.email || workspace.currentInbox?.displayName || 'Your workspace');
	const userDetail = $derived(
		workspace.customer
			? `${workspace.customer.email} · ${workspace.customer.role === 'admin' ? 'Owner' : workspace.customer.inboxLimit == null ? 'No inbox limit' : `${workspace.customer.inboxLimit} inboxes`}`
			: 'Owner'
	);
	const organization = $derived(workspace.customer?.organizationName || 'Your workspace');

	// Close the mobile drawer whenever the route changes.
	$effect(() => {
		void page.url.pathname;
		layoutState.sidebarOpen = false;
	});

	async function signOut() {
		try {
			await workspace.signOut();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Could not sign out. Try again.');
		}
	}

	const iconRow = 'flex items-center min-h-9 rounded-[var(--radius-inner)] py-1 text-[13px] font-medium transition-colors duration-150';
</script>

{#if !ready}
	<div class="flex min-h-dvh items-center justify-center bg-[var(--bg)]" aria-busy="true">
		<Spinner label="Loading workspace" />
	</div>
{:else}
	{#if layoutState.sidebarOpen}
		<div
			class="fixed inset-0 z-40 bg-[var(--scrim)] md:hidden"
			onclick={() => (layoutState.sidebarOpen = false)}
			onkeydown={(e) => e.key === 'Escape' && (layoutState.sidebarOpen = false)}
			role="button"
			tabindex="-1"
			aria-label="Close sidebar"
		></div>
	{/if}

	<div class="flex h-dvh overflow-hidden bg-[var(--bg)]">
		<aside
			class="fixed inset-y-0 left-0 z-50 flex h-dvh flex-col border-r border-[var(--ds-border)] bg-[var(--bg)] transition-all duration-200 md:sticky md:top-0 md:self-start md:translate-x-0 {layoutState.sidebarOpen
				? 'translate-x-0'
				: '-translate-x-full'} {sidebarCollapsed ? 'md:w-13' : ''} w-[260px]"
			aria-label="Workspace navigation"
		>
			<div class="flex h-12 shrink-0 items-center gap-2 {sidebarCollapsed ? 'md:justify-center md:px-2' : ''} px-4">
				<a href="/inboxes" class="flex min-w-0 items-center gap-2 {sidebarCollapsed ? 'md:hidden' : ''}">
					<span class="text-[14px] font-semibold tracking-[-0.01em] text-foreground">Goshen Email</span>
				</a>
				<button
					class="{sidebarCollapsed ? '' : 'ml-auto'} hidden rounded-[var(--radius-inner)] p-1 text-[var(--muted-fg)] transition-colors duration-150 hover:text-[var(--fg)] md:block"
					onclick={toggleSidebarCollapse}
					aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
					title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				>
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<rect x="3" y="3" width="18" height="18" rx="2" stroke-linecap="round" stroke-linejoin="round" />
						<path stroke-linecap="round" stroke-linejoin="round" d="M9 3v18" />
					</svg>
				</button>
				<button
					class="ml-auto rounded-[var(--radius-inner)] p-1 text-[var(--muted-fg)] transition-colors duration-150 hover:text-[var(--fg)] md:hidden"
					onclick={() => (layoutState.sidebarOpen = false)}
					aria-label="Close sidebar"
				>
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>

			<div class="shrink-0 px-2 pt-2">
				<button
					type="button"
					class="{iconRow} w-full {sidebarCollapsed ? 'md:justify-center md:px-2' : ''} gap-2.5 px-2.5 {composeTarget
						? 'text-[var(--muted-fg)] hover:text-[var(--fg)]'
						: 'cursor-not-allowed text-[var(--muted-fg)] opacity-50'}"
					disabled={!composeTarget}
					onclick={() => (workspace.composeFor = composeTarget)}
					title={composeTarget ? (sidebarCollapsed ? 'New message' : undefined) : 'Create an inbox to send mail.'}
				>
					<svg class="h-[18px] w-[18px] shrink-0 text-[var(--muted-fg)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
						/>
					</svg>
					<span class="flex-1 text-left {sidebarCollapsed ? 'md:hidden' : ''}">New message</span>
				</button>
			</div>

			<div class="flex-1 overflow-y-auto px-2 pt-0.5 pb-2.5">
				<nav aria-label="Main navigation">
					{#each navItems as item (item.href)}
						{@const active = isActive(item.href)}
						<a
							href={item.href}
							class="{iconRow} {sidebarCollapsed ? 'md:justify-center md:px-2' : ''} gap-2.5 px-2.5 {active
								? 'bg-[var(--active)] text-[var(--fg)]'
								: 'text-[var(--muted-fg)] hover:text-[var(--fg)]'}"
							aria-current={active ? 'page' : undefined}
							title={sidebarCollapsed ? item.label : undefined}
						>
							<svg class="h-[18px] w-[18px] shrink-0 {active ? 'text-[var(--accent)]' : 'text-[var(--muted-fg)]'}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
							</svg>
							<span class={sidebarCollapsed ? 'md:hidden' : ''}>{item.label}</span>
						</a>
					{/each}
				</nav>

				{#if !sidebarCollapsed && workspace.inboxes.length > 0}
					<div class="mt-3">
						<h2 class="px-2.5 py-1.5 text-[12px] font-medium uppercase tracking-[0.01em] text-[var(--muted-fg)]">Recent inboxes</h2>
						{#each workspace.inboxes.slice(0, 6) as inbox (inbox.inboxId)}
							{@const href = `/inboxes/${encodeURIComponent(inbox.inboxId)}`}
							<a
								{href}
								class="flex min-h-8 items-center gap-2.5 truncate rounded-[var(--radius-inner)] px-2.5 py-1 text-[13px] transition-colors duration-150 {page.url.pathname === href
									? 'bg-[var(--active)] text-[var(--fg)]'
									: 'text-[var(--muted-fg)] hover:text-[var(--fg)]'}"
								title={inbox.address ?? inbox.inboxId}
							>
								<span class="size-1.5 shrink-0 rounded-full {inbox.deliveryStatus === 'pending' ? 'bg-[var(--status-warning-fg)]' : 'bg-[var(--status-success-fg)]'}"></span>
								<span class="truncate">{inbox.displayName || inbox.inboxId}</span>
							</a>
						{/each}
					</div>
				{/if}
			</div>

			{#if workspace.showSetup}
				<div class="shrink-0 px-2 pb-1.5">
					<a
						href="/setup"
						class="{iconRow} {sidebarCollapsed ? 'md:justify-center md:px-2' : ''} gap-2.5 px-2.5 {isActive('/setup')
							? 'bg-[var(--active)] text-[var(--fg)]'
							: 'text-[var(--muted-fg)] hover:text-[var(--fg)]'}"
						aria-current={isActive('/setup') ? 'page' : undefined}
						title={sidebarCollapsed ? 'Get started' : undefined}
					>
						<svg class="h-[18px] w-[18px] shrink-0 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
							<path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
						</svg>
						<span class={sidebarCollapsed ? 'md:hidden' : ''}>Get started</span>
					</a>
				</div>
			{/if}

			<div class="shrink-0 border-t border-[var(--ds-border)] px-2 py-2.5" aria-label="User account">
				<div class="flex items-center {sidebarCollapsed ? 'md:justify-center' : ''} gap-1.5">
					<DropdownMenu.Root>
						<DropdownMenu.Trigger
							class="flex min-w-0 items-center rounded-[var(--radius-inner)] transition-colors duration-150 hover:bg-[var(--surface-2)] {sidebarCollapsed
								? 'md:h-8 md:w-8 md:justify-center md:p-0'
								: ''} flex-1 gap-2.5 px-2 py-2"
							aria-label="Account menu"
							title={sidebarCollapsed ? userName : undefined}
						>
							<FallbackAvatar name={userName} size={28} class="h-7 w-7 shrink-0" />
							<span class="min-w-0 flex-1 text-left {sidebarCollapsed ? 'md:hidden' : ''}">
								<span class="block truncate text-[13px] font-medium text-foreground" data-testid="account-name">{userName}</span>
								<span class="block truncate text-[11px] text-[var(--muted-fg)]">{organization}</span>
							</span>
							<svg class="h-3.5 w-3.5 shrink-0 text-[var(--subtle)] {sidebarCollapsed ? 'md:hidden' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
							</svg>
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="start" side="top" class="w-60">
							<div class="px-2.5 py-2">
								<p class="truncate text-[13px] font-medium text-foreground">{userName}</p>
								<p class="truncate text-[11px] text-[var(--muted-fg)]">{userDetail}</p>
							</div>
							<div class="mx-1 my-1.5 h-px bg-[var(--active)]"></div>
							{#each userMenuItems as item (item.href)}
								<DropdownMenu.Item onclick={() => void goto(item.href)}>
									<svg class="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
										<path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
									</svg>
									{item.label}
								</DropdownMenu.Item>
							{/each}
							{#if userMenuItems.length}<div class="mx-1 my-1.5 h-px bg-[var(--active)]"></div>{/if}
							<DropdownMenu.Item onclick={signOut}>
								<svg class="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
									<path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
								</svg>
								Sign out
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger
							class="shrink-0 rounded-[var(--radius-inner)] p-2 text-[var(--muted-fg)] transition-colors duration-150 hover:bg-[var(--surface-2)] hover:text-foreground {sidebarCollapsed ? 'md:hidden' : ''}"
							title="Theme"
							aria-label="Select theme"
						>
							{#if currentTheme === 'light'}
								<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
									<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
								</svg>
							{:else}
								<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
									<path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
								</svg>
							{/if}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" side="top" class="w-52">
							{#each THEME_OPTIONS as option (option.id)}
								<DropdownMenu.Item onclick={() => chooseTheme(option.id)}>
									<div class="flex w-full items-center justify-between gap-3">
										<span class="flex items-center gap-2">
											<span class="h-2.5 w-2.5 rounded-full border border-[var(--border-color)]" style:background-color={option.swatch}></span>
											<span>{option.label}</span>
										</span>
										{#if currentTheme === option.id}
											<svg class="h-4 w-4 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
												<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
											</svg>
										{/if}
									</div>
								</DropdownMenu.Item>
							{/each}
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</div>
			</div>
		</aside>

		<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
			<header class="flex h-12 items-center gap-3 border-b border-[var(--ds-border)] bg-[var(--bg)] px-4 md:hidden">
				<button
					class="rounded-[var(--radius-inner)] p-1 text-[var(--muted-fg)] transition-colors duration-150 hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
					onclick={() => (layoutState.sidebarOpen = true)}
					aria-label="Open menu"
					title="Menu"
				>
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
					</svg>
				</button>
				<span class="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">Goshen Email</span>
			</header>
			<main class="min-h-0 flex-1 bg-[var(--bg)] {isMailPage ? 'overflow-hidden' : 'overflow-y-auto'}">
				{@render children?.()}
			</main>
		</div>
	</div>

	<ComposeDialog />
	<CreateInboxDialog />
	<DeleteInboxDialog />
	<CredentialsDialog />
{/if}
