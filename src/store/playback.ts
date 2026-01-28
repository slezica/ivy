import type { AudioPlayerService, DatabaseService, PlaybackStatus } from '../services'
import type { PlaybackSlice, SetState, GetState } from './types'
import { createPlay } from '../actions/play'
import { createPause } from '../actions/pause'
import { createSeek } from '../actions/seek'
import { createSeekClip } from '../actions/seek_clip'
import { createSkipForward } from '../actions/skip_forward'
import { createSkipBackward } from '../actions/skip_backward'
import { createSyncPlaybackState } from '../actions/sync_playback_state'


export interface PlaybackSliceDeps {
  audio: AudioPlayerService
  db: DatabaseService
}


export function createPlaybackSlice(deps: PlaybackSliceDeps) {
  const { audio, db } = deps

  return (set: SetState, get: GetState): PlaybackSlice => {
    const play = createPlay({ audio, db, set, get })
    const pause = createPause({ audio, set })
    const seek = createSeek({ audio, set, get })
    const seekClip = createSeekClip({ get, play })
    const skipForward = createSkipForward({ audio })
    const skipBackward = createSkipBackward({ audio })
    const syncPlaybackState = createSyncPlaybackState({ audio, set })

    audio.on('status', onPlaybackStatus)

    return {
      playback: {
        status: 'idle',
        ownerId: null,
        uri: null,
        position: 0,
        duration: 0,
      },

      play,
      pause,
      seek,
      seekClip,
      skipForward,
      skipBackward,
      syncPlaybackState,
    }

    function onPlaybackStatus(status: PlaybackStatus) {
      set((state) => {
        if (state.playback.status !== 'loading') {
          state.playback.status = status.status
        }
        state.playback.position = status.position
      })
    }
  }
}
