/**
 * Jest configuration.
 *
 * `jest-expo` is the SDK-matched preset for Expo SDK 54. It supplies the Babel/Metro
 * transform, React Native module mapping, and native-module mocks, so no custom
 * transform config is needed here.
 *
 * Only files under `src/**\/__tests__` are treated as tests, which keeps fixtures and
 * helpers living next to the code they exercise from being collected as suites.
 */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts', '<rootDir>/src/**/__tests__/**/*.test.tsx'],
  clearMocks: true,

  /**
   * Components read colours through `useTheme`, which lives in a context that also
   * initialises Firebase. Firebase's web build ships ESM that Jest cannot transform,
   * so any suite that renders a themed component would fail on import alone.
   *
   * Stubbing the context module keeps theme-dependent components renderable without
   * booting a Firebase app. Tests that care about specific colours pass them through
   * the exported factory instead.
   */
  moduleNameMapper: {
    '^\\.\\./\\.\\./context/ThemeContext$': '<rootDir>/src/__tests__/support/themeContextStub.tsx',
    '^\\.\\./context/ThemeContext$': '<rootDir>/src/__tests__/support/themeContextStub.tsx',
    '^\\.\\./\\.\\./\\.\\./context/ThemeContext$': '<rootDir>/src/__tests__/support/themeContextStub.tsx',
  },

  collectCoverageFrom: [
    'src/domain/**/*.ts',
    'src/data/**/*.ts',
    'src/components/**/*.tsx',
    'src/screens/**/*.tsx',
  ],
};
