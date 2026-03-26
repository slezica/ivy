import type { DatabaseService, AudioSlicerService, SyncQueueService, TranscriptionQueueService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'
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
    const log = createLogger('UpdateClip')

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

      log(`Re-slicing ${id}: ${newStart}ms + ${newDuration}ms`)

      // Slice to temp location, then replace old file on success
      const sliceResult = await slicer.slice({
        sourceUri: clip.file_uri,
        startMs: newStart,
        endMs: newStart + newDuration,
      })

      await slicer.move(sliceResult.path, `${CLIPS_DIR}/${id}.m4a`)

      newUri = `file://${CLIPS_DIR}/${id}.m4a`

      // Clear stale transcription (will re-queue below)
      updates.transcription = null
    }

    // Update database
    await db.updateClip(id, { ...updates, uri: newUri })

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
      log(`Bounds changed, re-queued transcription for ${id}`)
    }
  }
)
