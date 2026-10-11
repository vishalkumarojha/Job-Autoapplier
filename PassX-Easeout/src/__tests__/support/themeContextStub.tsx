/**
 * Test double for `src/context/ThemeContext`.
 *
 * The real module boots Firebase to load the user's dark-mode preference, and Firebase's
 * web bundle is ESM that Jest cannot transform. Mapping this module in `jest.config.js`
 * lets themed components render under test without a Firebase connection.
 *
 * `setThemeOverride` lets a test pin specific colours; otherwise the light theme is used.
 */
import type { AppTheme } from '../../context/ThemeContext';

const light: AppTheme = {
  isDark: false,
  background: '#F8F9FA',
  card: '#FFFFFF',
  textMain: '#2C3E50',
  textSub: '#95A5A6',
  border: '#F0F0F0',
  iconBg: '#F0F9F9',
  inputBg: '#F5F5F5',
  navBg: '#FFFFFF',
};

let current: AppTheme = light;

export function setThemeOverride(theme: Partial<AppTheme>): void {
  current = { ...light, ...theme };
}

export function resetThemeOverride(): void {
  current = light;
}

export function useTheme() {
  return { theme: current, toggleTheme: () => {} };
}

export const ThemeProvider = ({ children }: { children: React.ReactNode }) => children;

export type { AppTheme };
