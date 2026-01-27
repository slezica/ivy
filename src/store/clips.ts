import RNFS from 'react-native-fs'
import type {
  DatabaseService,
  AudioSlicerService,
  SyncQueueService,
  TranscriptionQueueService,
  SharingService,
  BackupSyncService,
  ClipWithFile,
  SyncNotification,
} from '../services'
import { generateId } from '../utils'
import type { ClipSlice, SetState, GetState } from './types'


const CLIPS_DIR = `${RNFS.DocumentDirectoryPath}/clips`
const DEFAULT_CLIP_DURATION_MS = 20 * 1000


export interface ClipSliceDeps {
  db: DatabaseService
  slicer: AudioSlicerService
  syncQueue: SyncQueueService
  transcription: TranscriptionQueueService
  sharing: SharingService
  sync: BackupSyncService
}


export function createClipSlice(deps: ClipSliceDeps) {
  const { db, slicer, syncQueue, transcription, sharing, sync } = deps

  return (set: SetState, get: GetState): ClipSlice => {
    transcription.on('complete', onTranscriptionComplete)
    sync.on('data', onSyncData)

    return {
      clips: {},

      fetchClips,
      addClip,
      updateClip,
      deleteClip,
      shareClip,
    }

    function onTranscriptionComplete({ clipId, transcription }: { clipId: string; transcription: string }) {
      updateClip(clipId, { transcription })
    }

    function onSyncData(notification: SyncNotification) {
      if (notification.clipsChanged.length > 0) {
        fetchClips()
      }
    }

    function fetchClips(): void {
      const clips: Record<string, ClipWithFile> = {}
      for (const clip of db.getAllClips()) {
        clips[clip.id] = clip
      }

      set({ clips })
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
      syncQueue.queueChange('clip', clip.id, 'upsert')

      // Reload all clips to include file information
      fetchClips()

      // Queue for transcription
      transcription.queueClip(clip.id)
    }

    async function updateClip(
      id: string,
      updates: { note?: string; start?: number; duration?: number; transcription?: string | null }
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

    async function deleteClip(id: string): Promise<void> {
      const { clips } = get()
      const clip = clips[id]

      // Delete clip audio file
      if (clip?.uri) {
        await slicer.cleanup(clip.uri)
      }

      db.deleteClip(id)

      // Queue for sync (delete operation)
      syncQueue.queueChange('clip', id, 'delete')

      set((state) => {
        delete state.clips[id]
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
  }
}
