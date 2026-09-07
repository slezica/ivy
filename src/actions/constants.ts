import RNFS from 'react-native-fs'

export const MIN_SESSION_DURATION_MS = 1000

export const SKIP_FORWARD_MS = 25 * 1000
export const SKIP_BACKWARD_MS = 30 * 1000

export const SLEEP_TIMER_FADE_MS = 10 * 1000

// "At the end" for play-restarts-from-the-top: the player parks a hair short
// of the duration when a track runs out (29999 of 30000 is typical)
export const TRACK_END_TOLERANCE_MS = 250

export const CLIPS_DIR = `${RNFS.DocumentDirectoryPath}/clips`
// New clips start near-zero (matches the timeline's MIN_SELECTION_DURATION
// floor — deliberately not exact 0) and grow via handles or linked playback
export const DEFAULT_CLIP_DURATION_MS = 250
