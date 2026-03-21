/**
 * Playback Service for react-native-track-player
 *
 * Handles remote control events from notification, lock screen, and Bluetooth.
 * This runs in a separate context and communicates with the main app via events.
 */

import TrackPlayer, { Event } from 'react-native-track-player'
import { SKIP_FORWARD_MS, SKIP_BACKWARD_MS } from '../../actions/constants'

export async function playbackService() {
  console.log('Playback service registered')

  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    console.log('Remote play event')
    TrackPlayer.play()
  })

  TrackPlayer.addEventListener(Event.RemotePause, () => {
    console.log('Remote pause event')
    TrackPlayer.pause()
  })

  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    TrackPlayer.stop()
  })

  TrackPlayer.addEventListener(Event.RemoteSeek, (event) => {
    TrackPlayer.seekTo(event.position)
  })

  TrackPlayer.addEventListener(Event.RemoteJumpForward, async (event) => {
    const progress = await TrackPlayer.getProgress()
    const newPosition = Math.min(progress.position + event.interval, progress.duration)
    TrackPlayer.seekTo(newPosition)
  })

  TrackPlayer.addEventListener(Event.RemoteJumpBackward, async (event) => {
    const progress = await TrackPlayer.getProgress()
    const newPosition = Math.max(progress.position - event.interval, 0)
    TrackPlayer.seekTo(newPosition)
  })

  TrackPlayer.addEventListener(Event.RemoteNext, async () => {
    const progress = await TrackPlayer.getProgress()
    const newPosition = Math.min(progress.position + SKIP_FORWARD_MS / 1000, progress.duration)
    TrackPlayer.seekTo(newPosition)
  })

  TrackPlayer.addEventListener(Event.RemotePrevious, async () => {
    const progress = await TrackPlayer.getProgress()
    const newPosition = Math.max(progress.position - SKIP_BACKWARD_MS / 1000, 0)
    TrackPlayer.seekTo(newPosition)
  })
}
