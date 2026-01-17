import 'react-native-get-random-values' // Must be first - polyfills crypto.randomUUID()
import TrackPlayer from 'react-native-track-player'
import { playbackService } from './src/services/audio/integration'

TrackPlayer.registerPlaybackService(() => playbackService)

// Must be last - starts the app
import 'expo-router/entry'
