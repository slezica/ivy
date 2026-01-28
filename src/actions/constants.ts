import RNFS from 'react-native-fs'

export const MIN_SESSION_DURATION_MS = 1000

export const SKIP_FORWARD_MS = 25 * 1000
export const SKIP_BACKWARD_MS = 30 * 1000

export const CLIPS_DIR = `${RNFS.DocumentDirectoryPath}/clips`
export const DEFAULT_CLIP_DURATION_MS = 20 * 1000
