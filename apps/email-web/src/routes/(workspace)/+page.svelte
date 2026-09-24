<script lang="ts">
	import { goto } from '$app/navigation';
	import { setupDismissed } from '$lib/components/setup/dismissal';
	import { useWorkspace } from '$lib/workspace.svelte';

	const workspace = useWorkspace();

	// A new account with no inboxes lands on the setup guide once; everyone else lands on their inboxes.
	$effect(() => {
		if (!workspace.inboxesLoaded && !workspace.inboxesError) return;
		const customerId = workspace.customer?.id;
		const firstRun = workspace.showSetup && workspace.inboxes.length === 0 && customerId && !setupDismissed(customerId);
		void goto(firstRun ? '/setup' : '/inboxes', { replaceState: true });
	});
</script>
