import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createDashboardApi, sessionEndReason } from '../src/lib/services/dashboard-api.ts';

function recorder(respond: (path: string, init?: RequestInit) => Response | Promise<Response>) {
	const calls: Array<{ path: string; init?: RequestInit }> = [];
	return {
		calls,
		api: createDashboardApi({
			fetch: async (path, init) => {
				calls.push({ path, init });
				return respond(path, init);
			}
		})
	};
}

test('operations post JSON to the dashboard RPC route and return the result', async () => {
	const { api, calls } = recorder(() => Response.json({ result: { inboxes: [] } }));
	assert.deepEqual(await api.rpc('listInboxes', { pageToken: 'p' }), { inboxes: [] });
	assert.equal(calls[0].path, '/api/rpc/listInboxes');
	assert.equal(calls[0].init?.method, 'POST');
	assert.equal(new Headers(calls[0].init?.headers).get('content-type'), 'application/json');
	assert.equal(calls[0].init?.body, '{"pageToken":"p"}');
});

test('the session is a plain GET and the Bezalel reader has its own route', async () => {
	const { api, calls } = recorder((path) => Response.json(path === '/api/session' ? { authenticated: false, authMode: 'account' } : { result: 1 }));
	assert.deepEqual(await api.session(), { authenticated: false, authMode: 'account' });
	assert.deepEqual(calls[0].init, {});
	await api.nativeRpc('listInboxes');
	assert.equal(calls[1].path, '/api/native-rpc/listInboxes');
	await api.auth('email-otp/send-verification-otp', { email: 'a@example.com' });
	assert.equal(calls[2].path, '/api/auth/email-otp/send-verification-otp');
});

test('failures keep the status and the server message', async () => {
	const { api } = recorder(() => Response.json({ error: 'Sign in to continue', authMode: 'account' }, { status: 401 }));
	await assert.rejects(api.rpc('listInboxes'), (error: unknown) => {
		assert.ok(error instanceof ApiError);
		assert.equal(error.status, 401);
		assert.equal(error.message, 'Sign in to continue');
		assert.equal(error.authMode, 'account');
		return true;
	});
});

test('unreadable responses and network failures become explained errors', async () => {
	const unreadable = recorder(() => new Response('<html>', { status: 502 }));
	await assert.rejects(unreadable.api.rpc('send'), { name: 'ApiError', status: 502, message: /unreadable response/ });
	const offline = recorder(() => {
		throw new TypeError('fetch failed');
	});
	await assert.rejects(offline.api.session(), { name: 'ApiError', status: 0, message: /Could not reach Goshen Email/ });
});

test('only a missing session or lost account access ends the session', () => {
	assert.equal(sessionEndReason(new ApiError('Sign in to continue', 401)), '');
	assert.equal(sessionEndReason(new ApiError('Your dashboard access has been disabled', 403, 'access_denied')), 'access_denied');
	assert.equal(sessionEndReason(new ApiError('Administrator access required', 403, 'forbidden')), null);
	assert.equal(sessionEndReason(new ApiError('Invalid request origin', 403)), null);
	assert.equal(sessionEndReason(new ApiError('Inbox limit reached', 402, 'billing_limit')), null);
	assert.equal(sessionEndReason(new Error('network')), null);
});
