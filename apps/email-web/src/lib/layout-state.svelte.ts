import { getContext, setContext } from "svelte";

/**
 * Dashboard layout UI state (currently just the mobile sidebar toggle).
 *
 * Previously exported as module-level `$state`, which leaks across SSR
 * requests because every request shares the module instance. The state is
 * now created per layout tree and shared via context (simplify plan 02):
 * `+layout.svelte` calls `provideDashboardLayoutState()` during init and
 * descendants (e.g. the chat route) read it with
 * `useDashboardLayoutState()`.
 */
export type DashboardLayoutState = { sidebarOpen: boolean };

const DASHBOARD_LAYOUT_STATE_KEY = Symbol("pluto.dashboard.layout-state");

export function provideDashboardLayoutState(): DashboardLayoutState {
	const layoutState = $state<DashboardLayoutState>({ sidebarOpen: false });
	setContext(DASHBOARD_LAYOUT_STATE_KEY, layoutState);
	return layoutState;
}

export function useDashboardLayoutState(): DashboardLayoutState {
	const layoutState = getContext<DashboardLayoutState | undefined>(
		DASHBOARD_LAYOUT_STATE_KEY,
	);
	if (!layoutState) {
		throw new Error(
			"Dashboard layout state context is missing; useDashboardLayoutState() must run under routes/dashboard/+layout.svelte.",
		);
	}
	return layoutState;
}
