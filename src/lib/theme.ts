// Light/dark theme handling — persisted in localStorage, falling back to the
// OS `prefers-color-scheme`. Mirrors the mockup's toggleTheme()/applyThemeIcon().

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'ctp-theme';

export function getStoredTheme(): Theme | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

export function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyThemeAttr(theme: Theme | null): void {
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}

/** Apply the persisted theme (if any) on startup; returns the effective theme. */
export function initTheme(): Theme {
  const stored = getStoredTheme();
  applyThemeAttr(stored);
  return stored ?? systemTheme();
}

/** Flip the effective theme and persist the explicit choice. */
export function toggleTheme(current: Theme): Theme {
  const next: Theme = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem(STORAGE_KEY, next);
  applyThemeAttr(next);
  return next;
}
