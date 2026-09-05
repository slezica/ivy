/**
 * Playback Service for react-native-track-player
 *
 * Handles remote control events from notification, lock screen, and Bluetooth.
 * This runs in a separate context and communicates with the main app via events.
 */

import TrackPlayer, { Event, State } from 'react-native-track-player'
import { SKIP_FORWARD_MS, SKIP_BACKWARD_MS } from '../../actions/constants'
import { createLogger } from '../../utils'

const log = createLogger('PlaybackService')

export async function playbackService() {
  log('Registered')

  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    log('Remote play')
    TrackPlayer.play()
  })

  TrackPlayer.addEventListener(Event.RemotePause, () => {
    log('Remote pause')
    TrackPlayer.pause()
  })

  // Single-button headsets and most Bluetooth controls send PLAY_PAUSE rather
  // than separate keys. RNTP forwards it as its own event instead of resolving
  // it against the player, so resolve here. (Found by the playback-integration
  // e2e flow, which dispatches the key through the media session.)
  TrackPlayer.addEventListener(Event.RemotePlayPause, async () => {
    const { state } = await TrackPlayer.getPlaybackState()
    const active = state === State.Playing || state === State.Buffering || state === State.Loading
    log('Remote play/pause', active ? '→ pause' : '→ play')
    if (active) TrackPlayer.pause()
    else TrackPlayer.play()
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
