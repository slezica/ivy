import type { DatabaseService, AudioSlicerService, SyncQueueService, TranscriptionQueueService } from '../services'
import type { GetState, Action, ActionFactory } from '../store/types'
import type { FetchClips } from './fetch_clips'
import { generateId } from '../utils'
import { CLIPS_DIR, DEFAULT_CLIP_DURATION_MS } from './constants'


export interface AddClipDeps {
  db: DatabaseService
  slicer: AudioSlicerService
  syncQueue: SyncQueueService
  transcription: TranscriptionQueueService
  get: GetState
  fetchClips: FetchClips
}

export type AddClip = Action<[string, number]>

export const createAddClip: ActionFactory<AddClipDeps, AddClip> = (deps) => (
  async (bookId, position) => {
    const { db, slicer, syncQueue, transcription, get, fetchClips } = deps

    const { books } = get()
    const book = books[bookId]

    if (!book) {
      throw new Error('Book not found')
    }
    if (!book.uri) {
      throw new Error('Book has been archived')
    }

    // Cap clip duration to not exceed remaining audio length
    const remainingDuration = book.duration - position
    const clipDuration = Math.min(DEFAULT_CLIP_DURATION_MS, remainingDuration)

    // Generate clip ID upfront and use it for filename
    const clipId = generateId()
    const filename = `${clipId}.mp3`
    await slicer.ensureDir(CLIPS_DIR)
    const sliceResult = await slicer.slice({
      sourceUri: book.uri,
      startMs: position,
      endMs: position + clipDuration,
      outputFilename: filename,
      outputDir: CLIPS_DIR,
    })

    const clip = db.createClip(
      clipId,
      bookId,
      sliceResult.uri,
      position,
      clipDuration,
      '' // Default empty note
    )

    // Queue for sync
    syncQueue.queueChange('clip', clip.id, 'upsert')

    // Reload all clips to include file information
    await fetchClips()

    // Queue for transcription
    transcription.queueClip(clip.id)
  }
)
