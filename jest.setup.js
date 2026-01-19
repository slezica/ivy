// Jest setup file
// Add global mocks for native modules that aren't available in the test environment

// Mock react-native-fs
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/documents',
  exists: jest.fn().mockResolvedValue(true),
  mkdir: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(''),
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
  copyFile: jest.fn().mockResolvedValue(undefined),
}))

// Mock expo-sqlite
jest.mock('expo-sqlite', () => ({
  openDatabaseSync: jest.fn(() => ({
    execSync: jest.fn(),
    runSync: jest.fn(),
    getFirstSync: jest.fn(),
    getAllSync: jest.fn(() => []),
  })),
}))

// Mock react-native-track-player
jest.mock('react-native-track-player', () => ({
  setupPlayer: jest.fn().mockResolvedValue(undefined),
  updateOptions: jest.fn().mockResolvedValue(undefined),
  add: jest.fn().mockResolvedValue(undefined),
  reset: jest.fn().mockResolvedValue(undefined),
  play: jest.fn().mockResolvedValue(undefined),
  pause: jest.fn().mockResolvedValue(undefined),
  seekTo: jest.fn().mockResolvedValue(undefined),
  getProgress: jest.fn().mockResolvedValue({ position: 0, duration: 0 }),
  getPlaybackState: jest.fn().mockResolvedValue({ state: 'paused' }),
  addEventListener: jest.fn(),
  Capability: {
    Play: 'play',
    Pause: 'pause',
    SeekTo: 'seekTo',
    JumpForward: 'jumpForward',
    JumpBackward: 'jumpBackward',
  },
  Event: {
    PlaybackState: 'playback-state',
    PlaybackProgressUpdated: 'playback-progress-updated',
  },
  State: {
    Playing: 'playing',
    Paused: 'paused',
    Stopped: 'stopped',
    Ready: 'ready',
    None: 'none',
  },
  AppKilledPlaybackBehavior: {
    StopPlaybackAndRemoveNotification: 'stop',
  },
}))

// Mock @react-native-google-signin/google-signin
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn().mockResolvedValue(true),
    isSignedIn: jest.fn().mockResolvedValue(false),
    signInSilently: jest.fn(),
    signIn: jest.fn(),
    signOut: jest.fn(),
    getTokens: jest.fn().mockResolvedValue({ accessToken: 'mock-token' }),
  },
  statusCodes: {
    SIGN_IN_REQUIRED: 'SIGN_IN_REQUIRED',
    SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED',
    IN_PROGRESS: 'IN_PROGRESS',
    PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
  },
}))

// Mock whisper.rn (virtual: true because it may not be resolvable in test env)
jest.mock('whisper.rn', () => ({
  initWhisper: jest.fn(),
}), { virtual: true })
