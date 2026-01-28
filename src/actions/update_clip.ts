import type { DatabaseService, AudioSlicerService, SyncQueueService, TranscriptionQueueService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'
import { CLIPS_DIR } from './constants'


export interface UpdateClipDeps {
  db: DatabaseService
  slicer: AudioSlicerService
  syncQueue: SyncQueueService
  transcription: TranscriptionQueueService
  set: SetState
  get: GetState
}

export type UpdateClipUpdates = {
  note?: string
  start?: number
  duration?: number
  transcription?: string | null
}

export type UpdateClip = Action<[string, UpdateClipUpdates]>

export const createUpdateClip: ActionFactory<UpdateClipDeps, UpdateClip> = (deps) => (
  async (id, updates) => {
    const { db, slicer, syncQueue, transcription, set, get } = deps

    const { clips } = get()
    const clip = clips[id]
    if (!clip) return

    const boundsChanged =
      (updates.start !== undefined && updates.start !== clip.start) ||
      (updates.duration !== undefined && updates.duration !== clip.duration)

    let newUri: string | undefined

    // Re-slice if bounds changed (only possible if source file exists)
    if (boundsChanged) {
      if (!clip.file_uri) {
        throw new Error('Cannot edit clip bounds: source file has been removed')
      }

      const newStart = updates.start ?? clip.start
      const newDuration = updates.duration ?? clip.duration

      // Re-slice using clip's UUID as filename
      const filename = `${id}.mp3`
      await slicer.ensureDir(CLIPS_DIR)
      const sliceResult = await slicer.slice({
        sourceUri: clip.file_uri,
        startMs: newStart,
        endMs: newStart + newDuration,
        outputFilename: filename,
        outputDir: CLIPS_DIR,
      })

      newUri = sliceResult.uri

      // Delete old clip file
      await slicer.cleanup(clip.uri)

      // Clear stale transcription (will re-queue below)
      updates.transcription = null
    }

    // Update database
    db.updateClip(id, { ...updates, uri: newUri })

    // Queue for sync
    syncQueue.queueChange('clip', id, 'upsert')

    // Update store
    set((state) => {
      const clip = state.clips[id]
      if (!clip) return
      if (updates.note !== undefined) clip.note = updates.note
      if (updates.start !== undefined) clip.start = updates.start
      if (updates.duration !== undefined) clip.duration = updates.duration
      if (updates.transcription !== undefined) clip.transcription = updates.transcription
      if (newUri) clip.uri = newUri
      clip.updated_at = Date.now()
    })

    // Re-queue for transcription if bounds changed
    if (boundsChanged) {
      transcription.queueClip(id)
    }
  }
)
