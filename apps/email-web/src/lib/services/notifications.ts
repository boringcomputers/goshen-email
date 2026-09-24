// Polls for new mail and shows one desktop alert per batch. Message contents never enter an alert.
import type { Customer } from './types.ts';

type Rpc = <T>(operation: string, input: Record<string, unknown>) => Promise<T>;
type Arrival = { id: string; inboxId: string };

export function createDesktopNotifications({ rpc, openInbox }: { rpc: Rpc; openInbox: (inboxId: string) => void }) {
	let account: string | null = null, enabled = false, since: string | null = null, busy = false, generation = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	const seen = new Set<string>(), visible = new Set<Notification>();
	function remember(ids: string[]) {
		for (const id of ids) seen.add(id);
		while (seen.size > 500) seen.delete(seen.values().next().value as string);
	}
	async function poll() {
		if (!account || !enabled || !since || busy || !('Notification' in window)) return;
		const current = generation, key = `bezalel-notifications:${account}`;
		busy = true;
		try {
			const { notifications } = await rpc<{ notifications: Arrival[] }>('getNotifications', { since });
			if (current !== generation) return;
			if (Notification.permission !== 'granted') return remember(notifications.map((item) => item.id));
			const show = () => {
				if (current !== generation) return;
				try {
					const stored = JSON.parse(localStorage.getItem(key) ?? '[]');
					if (Array.isArray(stored)) for (const id of stored) seen.add(id);
				} catch {
					// A corrupt record only means an alert may repeat.
				}
				const fresh = notifications.filter((item) => !seen.has(item.id));
				if (!fresh.length) return;
				const alert = new Notification('New mail in Goshen Email', {
					body: fresh.length === 1 ? `New mail in ${fresh[0].inboxId}` : `${fresh.length} new messages in your inboxes`,
					tag: 'bezalel-new-mail'
				});
				visible.add(alert);
				alert.onclose = () => visible.delete(alert);
				alert.onclick = () => {
					if (current !== generation) return;
					window.focus();
					openInbox(fresh[0].inboxId);
					alert.close();
				};
				remember(fresh.map((item) => item.id));
				try {
					localStorage.setItem(key, JSON.stringify([...seen]));
				} catch {
					// Storage is optional.
				}
			};
			// Several open tabs share one lock so only one of them alerts.
			if (navigator.locks) await navigator.locks.request(key, show);
			else if (document.hasFocus()) show();
		} catch {
			// A later poll retries temporary network or browser failures.
		} finally {
			if (current === generation) busy = false;
		}
	}
	function reset() {
		generation++;
		clearInterval(timer);
		timer = undefined;
		account = null;
		busy = false;
		since = null;
		seen.clear();
		for (const alert of visible) alert.close();
		visible.clear();
	}
	return {
		start(customer?: Customer) {
			if (!customer || (account === customer.id && enabled === (customer.desktopNotifications === true))) return;
			reset();
			account = customer.id;
			enabled = customer.desktopNotifications === true;
			since = customer.notificationCursor ?? null;
			timer = setInterval(poll, 30_000);
			void poll();
		},
		reset
	};
}
