export type ThemeId = 'dark' | 'light';

// static/theme.js reads the same key before first paint.
const THEME_STORAGE_KEY = 'theme';

export const THEME_OPTIONS: Array<{ id: ThemeId; label: string; swatch: string }> = [
	{ id: 'dark', label: 'Obsidian', swatch: '#4466ff' },
	{ id: 'light', label: 'Porcelain', swatch: '#ffffff' }
];

export function detectTheme(): ThemeId {
	if (typeof document === 'undefined') return 'dark';
	return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

export function applyTheme(theme: ThemeId): void {
	if (typeof document === 'undefined') return;
	document.documentElement.classList.toggle('light', theme === 'light');
	try {
		localStorage.setItem(THEME_STORAGE_KEY, theme);
	} catch {
		// ignore storage failures
	}
}
