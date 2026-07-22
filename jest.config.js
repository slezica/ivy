module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  // Sibling git worktrees (worktree2/, worktree3/, ...) are full checkouts —
  // without this, jest runs their test copies too
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/worktree'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@shopify/react-native-skia|react-native-fs|react-native-track-player|@react-native-google-signin/google-signin|whisper.rn|zustand|immer)',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
}
