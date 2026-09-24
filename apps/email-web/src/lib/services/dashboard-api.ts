// The only path to the email service. The browser calls the dashboard server's /api endpoints,
// and the dashboard server holds every credential, so no token ever reaches this app.
import type { Customer } from './types.ts';

export type AuthMode = 'account' | 'access' | 'password';

export type Session = {
	authenticated: boolean;
	authMode?: AuthMode;
	customer?: Customer;
	defaultDomain?: string;
	apiUrl?: string;
	customDomainsEnabled?: boolean;
	nativeMailEnabled?: boolean;
};

export class ApiError extends Error {
	status: number;
	code?: string;
	authMode?: AuthMode;

	constructor(message: string, status: number, code?: string, authMode?: AuthMode) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.authMode = authMode;
	}
}

// Only a missing session (401) or an account that lost dashboard access (403 access_denied) ends the
// session. Any other 403 refuses one operation for a user who is still signed in.
export function sessionEndReason(error: unknown): '' | 'access_denied' | null {
	if (!(error instanceof ApiError)) return null;
	if (error.status === 401) return '';
	if (error.status === 403 && error.code === 'access_denied') return 'access_denied';
	return null;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function createDashboardApi({ fetch }: { fetch: Fetch }) {
	async function request<T>(path: string, body?: unknown): Promise<T> {
		let response: Response;
		try {
			response = await fetch(
				path,
				body === undefined
					? {}
					: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
			);
		} catch {
			throw new ApiError('Could not reach Goshen Email. Check your connection and try again.', 0);
		}
		let value: { error?: string; message?: string; code?: string; authMode?: AuthMode } & Record<string, unknown>;
		try {
			value = await response.json();
		} catch {
			throw new ApiError('The dashboard returned an unreadable response. Reload the page to try again.', response.status);
		}
		if (!response.ok)
			throw new ApiError(value?.error ?? value?.message ?? 'Email request failed', response.status, value?.code, value?.authMode);
		return value as T;
	}

	return {
		session: () => request<Session>('/api/session'),
		rpc: async <T = unknown>(operation: string, input: Record<string, unknown> = {}) =>
			(await request<{ result: T }>(`/api/rpc/${operation}`, input)).result,
		nativeRpc: async <T = unknown>(operation: string, input: Record<string, unknown> = {}) =>
			(await request<{ result: T }>(`/api/native-rpc/${operation}`, input)).result,
		login: (password: string) => request<{ authenticated: boolean }>('/api/login', { password }),
		logout: () => request<{ authenticated: false; logoutUrl?: string }>('/api/logout', {}),
		auth: (endpoint: string, body: Record<string, unknown>) => request<Record<string, unknown>>(`/api/auth/${endpoint}`, body)
	};
}

export type DashboardApi = ReturnType<typeof createDashboardApi>;
