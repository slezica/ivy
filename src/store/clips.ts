/**
 * Clip Slice
 *
 * State and actions for managing audio clips.
 */

import RNFS from 'react-native-fs'
import type {
  DatabaseService,
  AudioSlicerService,
  OfflineQueueService,
  TranscriptionQueueService,
  SharingService,
  ClipWithFile,
} from '../services'
import { generateId } from '../utils'
import type { ClipSlice, SetState, GetState } from './types'

// =============================================================================
// Constants
// =============================================================================

const CLIPS_DIR = `${RNFS.DocumentDirectoryPath}/clips`
const DEFAULT_CLIP_DURATION_MS = 20 * 1000

// =============================================================================
// Types
// =============================================================================

/** Dependencies required by this slice */
export interface ClipSliceDeps {
  db: DatabaseService
  slicer: AudioSlicerService
  queue: OfflineQueueService
  transcription: TranscriptionQueueService
  sharing: SharingService
}

// =============================================================================
// Slice Creator
// =============================================================================

/**
 * Creates the clip slice with injected dependencies.
 *
 * Usage:
 * ```
 * const clipSlice = createClipSlice({
 *   db: dbService,
 *   slicer: slicerService,
 *   ...
 * })(set, get)
 * ```
 */
export function createClipSlice(deps: ClipSliceDeps) {
  const { db, slicer, queue, transcription, sharing } = deps

  return (set: SetState, get: GetState): ClipSlice => {
    // -----------------------------------------------------------------
    // Actions
    // -----------------------------------------------------------------

    function fetchClips(): void {
      const allClips = db.getAllClips()

      const clipsMap = allClips.reduce((acc, clip) => {
        acc[clip.id] = clip
        return acc
      }, {} as Record<string, ClipWithFile>)

      set({ clips: clipsMap })
    }

    async function addClip(bookId: string, position: number): Promise<void> {
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
      queue.queueChange('clip', clip.id, 'upsert')

      // Reload all clips to include file information
      fetchClips()

      // Queue for transcription
      transcription.queueClip(clip.id)
    }

    async function updateClip(
      id: string,
      updates: { note?: string; start?: number; duration?: number }
    ): Promise<void> {
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
      }

      // Update database
      db.updateClip(id, { ...updates, uri: newUri })

      // Queue for sync
      queue.queueChange('clip', id, 'upsert')

      // Update store
      set((state) => ({
        ...state,
        clips: {
          ...state.clips,
          [id]: {
            ...state.clips[id],
            ...updates,
            ...(newUri && { uri: newUri }),
            updated_at: Date.now(),
          },
        },
      }))
    }

    function updateClipTranscription(id: string, transcription: string): void {
      set((state) => {
        const clip = state.clips[id]
        if (!clip) return state

        return {
          ...state,
          clips: {
            ...state.clips,
            [id]: {
              ...clip,
              transcription,
              updated_at: Date.now(),
            },
          },
        }
      })
    }

    async function deleteClip(id: string): Promise<void> {
      const { clips } = get()
      const clip = clips[id]

      // Delete clip audio file
      if (clip?.uri) {
        await slicer.cleanup(clip.uri)
      }

      db.deleteClip(id)

      // Queue for sync (delete operation)
      queue.queueChange('clip', id, 'delete')

      set((state) => {
        const { [id]: removed, ...rest } = state.clips
        return { ...state, clips: rest }
      })
    }

    async function shareClip(clipId: string): Promise<void> {
      const { clips } = get()
      const clip = clips[clipId]

      if (!clip) {
        throw new Error('Clip not found')
      }

      // Share using the clip's existing audio file
      await sharing.shareClipFile(clip.uri, clip.note || clip.file_name)
    }

    // -----------------------------------------------------------------
    // Return slice
    // -----------------------------------------------------------------

    return {
      // Initial state
      clips: {},

      // Actions
      fetchClips,
      addClip,
      updateClip,
      updateClipTranscription,
      deleteClip,
      shareClip,
    }
  }
}
