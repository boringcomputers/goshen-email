// The classic dashboard's key, so both apps agree on dismissal when served from one origin.
const key = (customerId: string) => `bezalel.setup.${customerId}`;

export function setupDismissed(customerId: string) {
	try {
		return localStorage.getItem(key(customerId)) === 'dismissed';
	} catch {
		return false;
	}
}

export function dismissSetup(customerId: string) {
	try {
		localStorage.setItem(key(customerId), 'dismissed');
	} catch {
		// Storage is optional; the guide may reappear on the next visit.
	}
}
