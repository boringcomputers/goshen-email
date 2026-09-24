<script lang="ts">
	import { Badge, type BadgeVariant } from '$lib/components/ds/badge';
	import { triageBadges, type TriageBadge } from '$lib/services/mail';
	import type { Triage } from '$lib/services/types';

	let { triage }: { triage?: Triage } = $props();

	const variant: Record<TriageBadge['tone'], BadgeVariant> = { neutral: 'secondary', info: 'blue', warning: 'amber', danger: 'red' };
	const badges = $derived(triageBadges(triage));
</script>

{#if badges.length}
	<div class="flex flex-wrap gap-1" aria-label="Email triage">
		{#each badges as badge (badge.label)}
			<Badge variant={variant[badge.tone]} size="sm" title={badge.title}>{badge.label}</Badge>
		{/each}
	</div>
{/if}
