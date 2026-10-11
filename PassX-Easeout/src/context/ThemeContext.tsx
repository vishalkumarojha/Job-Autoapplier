import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { firestore } from '../services/firebase';

// ─── Color Tokens ──────────────────────────────────────────────────────────────

export interface AppTheme {
  isDark: boolean;
  background: string;
  card: string;
  textMain: string;
  textSub: string;
  border: string;
  iconBg: string;
  inputBg: string;
  navBg: string;
}

const lightTheme: AppTheme = {
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

const darkTheme: AppTheme = {
  isDark: true,
  background: '#121212',
  card: '#1E1E1E',
  textMain: '#FFFFFF',
  textSub: '#AAAAAA',
  border: '#333333',
  iconBg: '#2C2C2C',
  inputBg: '#2C2C2C',
  navBg: '#1A1A1A',
};

// ─── Context ──────────────────────────────────────────────────────────────────

interface ThemeContextType {
  theme: AppTheme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: lightTheme,
  toggleTheme: () => {},
});

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [isDark, setIsDark] = useState(false);

  // Load preference from Firestore on login
  useEffect(() => {
    if (!user) return;
    const unsub = firestore()
      .collection('users')
      .doc(user.uid)
      .onSnapshot((doc) => {
        const pref = doc.data()?.preferences?.darkMode;
        if (typeof pref === 'boolean') setIsDark(pref);
      });
    return unsub;
  }, [user]);

  const toggleTheme = async () => {
    const newValue = !isDark;
    setIsDark(newValue);
    if (user) {
      await firestore()
        .collection('users')
        .doc(user.uid)
        .set({ preferences: { darkMode: newValue } }, { merge: true });
    }
  };

  return (
    <ThemeContext.Provider value={{ theme: isDark ? darkTheme : lightTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useTheme() {
  return useContext(ThemeContext);
}
