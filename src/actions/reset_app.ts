import type { DatabaseService, AudioPlayerService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'


export interface ResetAppDeps {
  db: DatabaseService
  audio: AudioPlayerService
  set: SetState
}

export type ResetApp = Action<[]>

export const createResetApp: ActionFactory<ResetAppDeps, ResetApp> = (deps) => (
  async () => {
    const { db, audio, set } = deps

    await audio.unload()
    db.clearAllData()

    set({
      library: { status: 'idle' },
      playback: {
        status: 'idle',
        position: 0,
        uri: null,
        duration: 0,
        ownerId: null,
      },
      sync: {
        isSyncing: false,
        pendingCount: 0,
        lastSyncTime: null,
        error: null,
      },
      clips: {},
      transcription: { status: 'idle', pending: {} },
      books: {},
      sessions: [],
      currentSessionBookId: null,
      settings: { sync_enabled: false, transcription_enabled: true },
    })

    console.log('App reset complete')
  }
)
