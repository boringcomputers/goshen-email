import { goto } from '$app/navigation';
import { getContext, setContext } from 'svelte';
import { ApiError, createDashboardApi, type Session } from './services/dashboard-api.ts';
import { customerMode, setupAvailable } from './services/mail.ts';
import type { Customer, Inbox } from './services/types.ts';

export const api = createDashboardApi({ fetch: (input, init) => fetch(input, init) });

// Signing out in one tab signs out the others; the classic dashboard listens on the same channel.
const accountChannel = 'bezalel-account';
const returnPattern = /^\/[a-z][a-z0-9-]*(\/[^\s#?]*)?(\?[^\s#]*)?$/;

export const safeReturnPath = (value: string | null | undefined) =>
	value && returnPattern.test(value) && !value.startsWith('//') ? value : '';

export class Workspace {
	session = $state<Session | null>(null);
	inboxes = $state<Inbox[]>([]);
	inboxesLoaded = $state(false);
	inboxesError = $state('');
	currentInboxId = $state('');
	// Bumped after a send or a label change so open mail views reload.
	mailVersion = $state(0);
	composeFor = $state<string | null>(null);
	credentialsFor = $state<string | null>(null);
	deleting = $state<Inbox | null>(null);
	creatingInbox = $state(false);

	customer = $derived(this.session?.customer);
	isCustomer = $derived(customerMode(this.session?.authMode));
	currentInbox = $derived(this.inboxes.find((inbox) => inbox.inboxId === this.currentInboxId));
	showDomains = $derived(!this.isCustomer || this.session?.customDomainsEnabled === true);
	showSetup = $derived(
		setupAvailable({ authMode: this.session?.authMode, hasCustomer: Boolean(this.customer), inbox: this.currentInbox })
	);

	#epoch = 0;
	#channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(accountChannel);

	constructor() {
		this.#channel?.addEventListener('message', (event) => {
			if (event.data === 'signed-out' && this.session) this.signedOut('', false);
		});
	}

	async start() {
		const session = await api.session();
		if (!session.authenticated) return false;
		this.session = session;
		return true;
	}

	async rpc<T = unknown>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
		const epoch = this.#epoch;
		try {
			const result = await api.rpc<T>(operation, input);
			if (epoch !== this.#epoch) throw new Error('Session changed. Sign in again.');
			return result;
		} catch (error) {
			if (error instanceof ApiError && (error.status === 401 || error.status === 403))
				this.signedOut(error.status === 403 ? 'access_denied' : '');
			throw error;
		}
	}

	// A 403 here means the account is not a Bezalel administrator, not that the session ended.
	async nativeRpc<T = unknown>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
		try {
			return await api.nativeRpc<T>(operation, input);
		} catch (error) {
			if (error instanceof ApiError && error.status === 401) this.signedOut('');
			throw error;
		}
	}

	async loadInboxes(preferred = this.currentInboxId) {
		const epoch = this.#epoch;
		const inboxes: Inbox[] = [], seen = new Set<string>();
		let pageToken: string | undefined;
		try {
			do {
				const page = await this.rpc<{ inboxes: Inbox[]; nextPageToken?: string }>('listInboxes', pageToken ? { pageToken } : {});
				if (epoch !== this.#epoch) return;
				inboxes.push(...page.inboxes);
				pageToken = page.nextPageToken;
				if (pageToken && seen.has(pageToken)) throw new Error('The inbox list could not finish loading. Try again.');
				if (pageToken) seen.add(pageToken);
			} while (pageToken);
		} catch (error) {
			if (epoch === this.#epoch) this.inboxesError = error instanceof Error ? error.message : 'Inboxes could not load.';
			throw error;
		}
		this.inboxes = inboxes;
		this.inboxesError = '';
		this.inboxesLoaded = true;
		this.currentInboxId = inboxes.some((inbox) => inbox.inboxId === preferred) ? preferred : (inboxes[0]?.inboxId ?? '');
	}

	async createInbox(input: Record<string, string>) {
		try {
			const result = await this.rpc<{ inboxId: string }>('createInbox', input);
			await this.loadInboxes(result.inboxId);
			return result;
		} catch (error) {
			await this.loadInboxes().catch(() => {});
			throw error;
		}
	}

	removeInbox(inboxId: string) {
		this.inboxes = this.inboxes.filter((inbox) => inbox.inboxId !== inboxId);
		if (this.currentInboxId === inboxId) this.currentInboxId = this.inboxes[0]?.inboxId ?? '';
		if (this.composeFor === inboxId) this.composeFor = null;
	}

	updateCustomer(customer: Customer) {
		if (this.session?.customer?.id === customer.id) this.session = { ...this.session, customer };
	}

	async signOut() {
		const { logoutUrl } = await api.logout();
		this.#channel?.postMessage('signed-out');
		this.signedOut('', false);
		if (logoutUrl === '/cdn-cgi/access/logout') location.assign(logoutUrl);
	}

	signedOut(reason: string, keepRoute = true) {
		if (!this.session && !this.inboxesLoaded) return;
		this.#epoch++;
		this.session = null;
		this.inboxes = [];
		this.inboxesLoaded = false;
		this.currentInboxId = '';
		this.composeFor = null;
		this.credentialsFor = null;
		this.deleting = null;
		this.creatingInbox = false;
		const query = new URLSearchParams();
		if (reason) query.set('reason', reason);
		const next = keepRoute ? safeReturnPath(`${location.pathname}${location.search}`) : '';
		if (next && next !== '/inboxes') query.set('next', next);
		void goto(`/sign-in${query.size ? `?${query}` : ''}`, { replaceState: true });
	}
}

const key = Symbol('goshen.workspace');

export function provideWorkspace() {
	return setContext(key, new Workspace());
}

export function useWorkspace(): Workspace {
	const workspace = getContext<Workspace | undefined>(key);
	if (!workspace) throw new Error('useWorkspace() must run under the workspace layout.');
	return workspace;
}
