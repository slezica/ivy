/**
 * Backup Sync Service
 *
 * Orchestrates incremental synchronization between local database and Google Drive.
 * Uses a manifest to track sync state and detect conflicts.
 *
 * KNOWN LIMITATION:
 * Timestamps are device-local. We store entity.updated_at in the manifest but compare
 * against Drive's modifiedTime. This can cause false conflict detection under clock
 * drift, but conflict resolution is idempotent so results are still correct.
 * See docs/sync_system.md "A Note on Timestamps" for details.
 */

import RNFS from 'react-native-fs'
import { databaseService, Book, Clip, SyncManifestEntry, SyncQueueItem } from '../storage'
import { googleDriveService, DriveFile } from './drive'
import { googleAuthService } from './auth'
import { offlineQueueService } from './queue'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BookBackup {
  id: string
  name: string
  duration: number
  position: number
  updated_at: number
  title: string | null
  artist: string | null
  artwork: string | null
  file_size: number
  fingerprint: string // base64-encoded
}

export interface ClipBackup {
  id: string
  source_id: string
  start: number
  duration: number
  note: string
  transcription: string | null
  created_at: number
  updated_at: number
}

export interface ConflictInfo {
  entityType: 'book' | 'clip'
  entityId: string
  resolution: string  // human-readable description of how it was resolved
}

export interface SyncResult {
  uploaded: { books: number; clips: number }
  downloaded: { books: number; clips: number }
  deleted: { clips: number }
  conflicts: ConflictInfo[]
  errors: string[]
}

export interface SyncNotification {
  booksChanged: string[]  // IDs of books that were modified by remote changes
  clipsChanged: string[]  // IDs of clips that were modified by remote changes
}

export interface SyncStatus {
  isSyncing: boolean
  pendingCount: number
  error: string | null
}

export interface SyncListeners {
  onStatusChange?: (status: SyncStatus) => void
  onDataChange?: (notification: SyncNotification) => void
}

// Filename format: {type}_{id}.{ext}
// Simplified from timestamp-based to just use entity ID
const FILENAME_REGEX = /^(book|clip)_([a-f0-9-]+)\.(json|mp3)$/

interface ParsedFilename {
  type: 'book' | 'clip'
  id: string
  extension: 'json' | 'mp3'
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class BackupSyncService {
  private listeners: SyncListeners = {}
  private isSyncing = false

  /**
   * Set callbacks for sync status and data changes.
   */
  setListeners(listeners: SyncListeners): void {
    this.listeners = listeners
  }

  /**
   * Get current pending count.
   */
  getPendingCount(): number {
    return offlineQueueService.getCount()
  }

  /**
   * Manual sync with user authentication prompts if needed.
   * Fire-and-forget - status updates via listeners.
   */
  async syncNow(): Promise<void> {
    if (this.isSyncing) return

    this.setStatus(true, null)

    try {
      await googleAuthService.initialize()

      if (!googleAuthService.isAuthenticated()) {
        const signedIn = await googleAuthService.signIn()
        if (!signedIn) {
          this.setStatus(false, 'Could not sign in to Google')
          return
        }
      }

      const result = await this.performSync()

      if (result.errors.length > 0) {
        this.setStatus(false, `${result.errors.length} error(s) occurred during sync`)
      } else {
        this.setStatus(false, null)
      }
    } catch (error) {
      console.error('Sync failed:', error)
      this.setStatus(false, String(error))
    }
  }

  /**
   * Silent background sync. Only runs if already authenticated.
   * Does not prompt for sign-in.
   */
  async autoSync(): Promise<void> {
    if (this.isSyncing) return

    await googleAuthService.initialize()
    if (!googleAuthService.isAuthenticated()) return

    this.setStatus(true, null)

    try {
      const result = await this.performSync()

      if (result.conflicts.length > 0) {
        console.log('Auto-sync conflicts resolved:', result.conflicts)
      }
      if (result.errors.length > 0) {
        console.warn('Auto-sync errors:', result.errors)
        this.setStatus(false, `${result.errors.length} error(s) occurred`)
      } else {
        this.setStatus(false, null)
      }
    } catch (error) {
      console.error('Auto-sync failed:', error)
      this.setStatus(false, String(error))
    }
  }

  private setStatus(isSyncing: boolean, error: string | null): void {
    this.isSyncing = isSyncing
    this.listeners.onStatusChange?.({
      isSyncing,
      pendingCount: this.getPendingCount(),
      error,
    })
  }

  /**
   * Perform incremental bidirectional sync.
   */
  private async performSync(): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: { books: 0, clips: 0 },
      downloaded: { books: 0, clips: 0 },
      deleted: { clips: 0 },
      conflicts: [],
      errors: [],
    }

    const notification: SyncNotification = {
      booksChanged: [],
      clipsChanged: [],
    }

    try {
      // Process offline queue first (push queued changes)
      await this.processQueue(result)

      // Then do incremental sync
      await this.syncBooks(result, notification)
      await this.syncClips(result, notification)

      // Update last sync time
      databaseService.setLastSyncTime(Date.now())

      // Notify store of external changes
      if (notification.booksChanged.length > 0 || notification.clipsChanged.length > 0) {
        this.listeners.onDataChange?.(notification)
      }
    } catch (error) {
      result.errors.push(`Sync failed: ${error}`)
    }

    console.log('Sync complete:', result)
    return result
  }

  // ---------------------------------------------------------------------------
  // Queue Processing
  // ---------------------------------------------------------------------------

  private async processQueue(result: SyncResult): Promise<void> {
    // Fetch remote state upfront to detect conflicts during queue processing
    const remoteBookFiles = await googleDriveService.listFiles('books')
    const remoteClipFiles = await googleDriveService.listFiles('clips')
    const remoteBooks = this.groupRemoteFiles(remoteBookFiles, 'book')
    const remoteClips = this.groupRemoteFiles(remoteClipFiles, 'clip')

    const processResult = await offlineQueueService.processQueue(async (item: SyncQueueItem) => {
      if (item.entity_type === 'book') {
        if (item.operation === 'upsert') {
          const book = databaseService.getBookById(item.entity_id)
          if (book) {
            await this.processBookUpsert(book, remoteBooks, result)
          }
        }
        // Books don't get deleted remotely (they're just archived locally)
      } else if (item.entity_type === 'clip') {
        if (item.operation === 'upsert') {
          const clip = databaseService.getClip(item.entity_id)
          if (clip) {
            await this.processClipUpsert(clip, remoteClips, remoteClipFiles, result)
          }
        } else if (item.operation === 'delete') {
          await this.deleteClipFromRemote(item.entity_id, result)
        }
      }
    })

    if (processResult.errors.length > 0) {
      result.errors.push(...processResult.errors.map(e => `Queue: ${e}`))
    }
  }

  /**
   * Process a book upsert with conflict detection.
   * Checks if remote changed since last sync and merges if needed.
   */
  private async processBookUpsert(
    book: Book,
    remoteBooks: Map<string, { file: DriveFile; timestamp: number }>,
    result: SyncResult
  ): Promise<void> {
    const manifest = databaseService.getManifestEntry('book', book.id)
    const remote = remoteBooks.get(book.id)

    // Check for conflict: remote changed since our last sync
    if (manifest && remote && remote.timestamp > (manifest.remote_updated_at || 0)) {
      // Conflict detected - merge before uploading
      const merged = await this.mergeBook(book, remote, result)
      await this.uploadBook(merged, result)
    } else {
      // No conflict - safe to upload directly
      await this.uploadBook(book, result)
    }
  }

  /**
   * Process a clip upsert with conflict detection.
   * Checks if remote changed since last sync and merges if needed.
   */
  private async processClipUpsert(
    clip: Clip,
    remoteClips: Map<string, { file: DriveFile; timestamp: number }>,
    allRemoteFiles: DriveFile[],
    result: SyncResult
  ): Promise<void> {
    const manifest = databaseService.getManifestEntry('clip', clip.id)
    const remote = remoteClips.get(clip.id)

    // Check for conflict: remote changed since our last sync
    if (manifest && remote && remote.timestamp > (manifest.remote_updated_at || 0)) {
      // Conflict detected - merge before uploading
      const merged = await this.mergeClip(clip, remote, allRemoteFiles, result)
      await this.uploadClip(merged, result)
    } else {
      // No conflict - safe to upload directly
      await this.uploadClip(clip, result)
    }
  }

  // ---------------------------------------------------------------------------
  // Books
  // ---------------------------------------------------------------------------

  private async syncBooks(result: SyncResult, notification: SyncNotification): Promise<void> {
    const localBooks = databaseService.getAllBooks()
    const remoteFiles = await googleDriveService.listFiles('books')

    // Build maps for quick lookup
    const remoteByBookId = this.groupRemoteFiles(remoteFiles, 'book')
    const localBooksMap = new Map(localBooks.map(b => [b.id, b]))

    // PUSH PHASE: Upload local changes
    for (const book of localBooks) {
      const manifest = databaseService.getManifestEntry('book', book.id)
      const remote = remoteByBookId.get(book.id)

      if (!manifest) {
        // New locally, upload
        await this.uploadBook(book, result)
      } else if (book.updated_at > (manifest.local_updated_at || 0)) {
        // Changed locally since last sync
        if (remote && remote.timestamp > (manifest.remote_updated_at || 0)) {
          // CONFLICT: both changed - merge and upload
          const merged = await this.mergeBook(book, remote, result)
          await this.uploadBook(merged, result)
        } else {
          // Changed locally only, upload
          await this.uploadBook(book, result)
        }
      }
    }

    // PULL PHASE: Download remote changes
    for (const [bookId, remote] of remoteByBookId) {
      const manifest = databaseService.getManifestEntry('book', bookId)
      const localBook = localBooksMap.get(bookId)

      if (!manifest) {
        // New remotely, download
        await this.downloadBook(remote.file, notification)
        result.downloaded.books++
      } else if (remote.timestamp > (manifest.remote_updated_at || 0)) {
        // Changed remotely since last sync
        if (!localBook || localBook.updated_at <= (manifest.local_updated_at || 0)) {
          // Not changed locally, safe to download
          await this.downloadBook(remote.file, notification)
          result.downloaded.books++
        }
        // If both changed, conflict was handled in push phase
      }
    }

    // Clean up manifest entries for deleted books
    const manifestEntries = databaseService.getAllManifestEntries('book')
    for (const entry of manifestEntries) {
      if (!localBooksMap.has(entry.entity_id) && !remoteByBookId.has(entry.entity_id)) {
        databaseService.deleteManifestEntry('book', entry.entity_id)
      }
    }
  }

  private async uploadBook(book: Book, result: SyncResult): Promise<void> {
    try {
      const backup: BookBackup = {
        id: book.id,
        name: book.name,
        duration: book.duration,
        position: book.position,
        updated_at: book.updated_at,
        title: book.title,
        artist: book.artist,
        artwork: book.artwork,
        file_size: book.file_size,
        fingerprint: uint8ArrayToBase64(book.fingerprint),
      }

      const filename = `book_${book.id}.json`
      const content = JSON.stringify(backup, null, 2)

      // Check if file already exists and delete it first
      const remoteFiles = await googleDriveService.listFiles('books')
      const existingFile = remoteFiles.find(f => f.name === filename)
      if (existingFile) {
        await googleDriveService.deleteFile(existingFile.id)
      }

      const uploaded = await googleDriveService.uploadFile('books', filename, content)

      // Update manifest
      databaseService.upsertManifestEntry({
        entity_type: 'book',
        entity_id: book.id,
        local_updated_at: book.updated_at,
        remote_updated_at: book.updated_at,
        remote_file_id: uploaded.id,
        remote_mp3_file_id: null,
      })

      result.uploaded.books++
      console.log(`Uploaded book: ${book.id}`)
    } catch (error) {
      result.errors.push(`Failed to upload book ${book.id}: ${error}`)
    }
  }

  private async downloadBook(file: DriveFile, notification: SyncNotification): Promise<void> {
    const content = await googleDriveService.downloadFile(file.id, false) as string
    const backup: BookBackup = JSON.parse(content)

    databaseService.restoreBookFromBackup(
      backup.id,
      backup.name,
      backup.duration,
      backup.position,
      backup.updated_at,
      backup.title,
      backup.artist,
      backup.artwork,
      backup.file_size,
      base64ToUint8Array(backup.fingerprint)
    )

    // Update manifest
    databaseService.upsertManifestEntry({
      entity_type: 'book',
      entity_id: backup.id,
      local_updated_at: backup.updated_at,
      remote_updated_at: backup.updated_at,
      remote_file_id: file.id,
      remote_mp3_file_id: null,
    })

    notification.booksChanged.push(backup.id)
    console.log(`Downloaded book: ${backup.id}`)
  }

  private async mergeBook(
    local: Book,
    remote: { file: DriveFile; timestamp: number },
    result: SyncResult
  ): Promise<Book> {
    // Download remote version
    const content = await googleDriveService.downloadFile(remote.file.id, false) as string
    const remoteBackup: BookBackup = JSON.parse(content)

    // Merge strategy:
    // - position: max value wins (user progressed further)
    // - other fields: last-write-wins based on updated_at
    const mergedPosition = Math.max(local.position, remoteBackup.position)
    const localWins = local.updated_at >= remoteBackup.updated_at

    const merged: Book = {
      ...local,
      position: mergedPosition,
      title: localWins ? local.title : remoteBackup.title,
      artist: localWins ? local.artist : remoteBackup.artist,
      artwork: localWins ? local.artwork : remoteBackup.artwork,
      updated_at: Date.now(),
    }

    // Update local database with merged result
    databaseService.restoreBookFromBackup(
      merged.id,
      merged.name,
      merged.duration,
      merged.position,
      merged.updated_at,
      merged.title,
      merged.artist,
      merged.artwork,
      merged.file_size,
      merged.fingerprint
    )

    result.conflicts.push({
      entityType: 'book',
      entityId: local.id,
      resolution: `Position: ${mergedPosition}ms (max), metadata: ${localWins ? 'local' : 'remote'} wins`,
    })

    console.log(`Merged book conflict: ${local.id}`)
    return merged
  }

  // ---------------------------------------------------------------------------
  // Clips
  // ---------------------------------------------------------------------------

  private async syncClips(result: SyncResult, notification: SyncNotification): Promise<void> {
    const localClips = databaseService.getAllClips()
    const remoteFiles = await googleDriveService.listFiles('clips')

    // Build maps for quick lookup
    const remoteByClipId = this.groupRemoteFiles(remoteFiles, 'clip')
    const localClipsMap = new Map(localClips.map(c => [c.id, c]))
    const localClipIds = new Set(localClips.map(c => c.id))

    // PUSH PHASE: Upload local changes
    for (const clip of localClips) {
      const manifest = databaseService.getManifestEntry('clip', clip.id)
      const remote = remoteByClipId.get(clip.id)

      if (!manifest) {
        // New locally, upload
        await this.uploadClip(clip, result)
      } else if (clip.updated_at > (manifest.local_updated_at || 0)) {
        // Changed locally since last sync
        if (remote && remote.timestamp > (manifest.remote_updated_at || 0)) {
          // CONFLICT: both changed - merge and upload
          const merged = await this.mergeClip(clip, remote, remoteFiles, result)
          await this.uploadClip(merged, result)
        } else {
          // Changed locally only, upload
          await this.uploadClip(clip, result)
        }
      }
    }

    // PULL PHASE: Download remote changes
    for (const [clipId, remote] of remoteByClipId) {
      const manifest = databaseService.getManifestEntry('clip', clipId)
      const localClip = localClipsMap.get(clipId)

      if (!manifest) {
        // New remotely, download
        await this.downloadClip(remote.file, remoteFiles, notification)
        result.downloaded.clips++
      } else if (remote.timestamp > (manifest.remote_updated_at || 0)) {
        // Changed remotely since last sync
        if (!localClip || localClip.updated_at <= (manifest.local_updated_at || 0)) {
          // Not changed locally, safe to download
          await this.downloadClip(remote.file, remoteFiles, notification)
          result.downloaded.clips++
        }
        // If both changed, conflict was handled in push phase
      }
    }

    // DELETE PHASE: Remove remote clips that were deleted locally
    // This is handled by the queue, but we also clean up orphans here
    for (const [clipId] of remoteByClipId) {
      const manifest = databaseService.getManifestEntry('clip', clipId)
      // If we have a manifest entry but no local clip, it was deleted
      if (manifest && !localClipIds.has(clipId)) {
        await this.deleteClipFromRemote(clipId, result)
      }
    }

    // Clean up manifest entries for deleted clips
    const manifestEntries = databaseService.getAllManifestEntries('clip')
    for (const entry of manifestEntries) {
      if (!localClipsMap.has(entry.entity_id) && !remoteByClipId.has(entry.entity_id)) {
        databaseService.deleteManifestEntry('clip', entry.entity_id)
      }
    }
  }

  private async uploadClip(clip: Clip, result: SyncResult): Promise<void> {
    const jsonFilename = `clip_${clip.id}.json`
    const mp3Filename = `clip_${clip.id}.mp3`

    let jsonFileId: string | null = null
    let mp3FileId: string | null = null

    try {
      const backup: ClipBackup = {
        id: clip.id,
        source_id: clip.source_id,
        start: clip.start,
        duration: clip.duration,
        note: clip.note,
        transcription: clip.transcription,
        created_at: clip.created_at,
        updated_at: clip.updated_at,
      }

      // Delete existing files first
      const remoteFiles = await googleDriveService.listFiles('clips')
      const existingJson = remoteFiles.find(f => f.name === jsonFilename)
      const existingMp3 = remoteFiles.find(f => f.name === mp3Filename)

      if (existingJson) await googleDriveService.deleteFile(existingJson.id)
      if (existingMp3) await googleDriveService.deleteFile(existingMp3.id)

      // Upload JSON first
      const jsonContent = JSON.stringify(backup, null, 2)
      const jsonFile = await googleDriveService.uploadFile('clips', jsonFilename, jsonContent)
      jsonFileId = jsonFile.id

      // Upload MP3
      const clipPath = clip.uri.replace('file://', '')
      const mp3Content = await RNFS.readFile(clipPath, 'base64')
      const mp3Bytes = base64ToUint8Array(mp3Content)
      const mp3File = await googleDriveService.uploadFile('clips', mp3Filename, mp3Bytes)
      mp3FileId = mp3File.id

      // Update manifest
      databaseService.upsertManifestEntry({
        entity_type: 'clip',
        entity_id: clip.id,
        local_updated_at: clip.updated_at,
        remote_updated_at: clip.updated_at,
        remote_file_id: jsonFileId,
        remote_mp3_file_id: mp3FileId,
      })

      result.uploaded.clips++
      console.log(`Uploaded clip: ${clip.id}`)
    } catch (error) {
      // Rollback: if JSON uploaded but MP3 failed, delete JSON
      if (jsonFileId && !mp3FileId) {
        try {
          await googleDriveService.deleteFile(jsonFileId)
        } catch (rollbackError) {
          console.warn('Failed to rollback JSON upload:', rollbackError)
        }
      }
      result.errors.push(`Failed to upload clip ${clip.id}: ${error}`)
    }
  }

  private async downloadClip(
    jsonFile: DriveFile,
    allFiles: DriveFile[],
    notification: SyncNotification
  ): Promise<void> {
    // Download JSON
    const jsonContent = await googleDriveService.downloadFile(jsonFile.id, false) as string
    const backup: ClipBackup = JSON.parse(jsonContent)

    // Find and download MP3
    const mp3Filename = `clip_${backup.id}.mp3`
    const mp3File = allFiles.find(f => f.name === mp3Filename)

    if (!mp3File) {
      throw new Error(`MP3 file not found for clip ${backup.id}`)
    }

    const mp3Bytes = await googleDriveService.downloadFile(mp3File.id, true) as Uint8Array

    // Save MP3 to clips directory
    const clipsDir = `${RNFS.DocumentDirectoryPath}/clips`
    if (!(await RNFS.exists(clipsDir))) {
      await RNFS.mkdir(clipsDir)
    }

    const localMp3Path = `${clipsDir}/${backup.id}.mp3`
    const mp3Base64 = uint8ArrayToBase64(mp3Bytes)
    await RNFS.writeFile(localMp3Path, mp3Base64, 'base64')

    const localUri = `file://${localMp3Path}`

    // Restore to database
    databaseService.restoreClipFromBackup(
      backup.id,
      backup.source_id,
      localUri,
      backup.start,
      backup.duration,
      backup.note,
      backup.transcription,
      backup.created_at,
      backup.updated_at
    )

    // Update manifest
    databaseService.upsertManifestEntry({
      entity_type: 'clip',
      entity_id: backup.id,
      local_updated_at: backup.updated_at,
      remote_updated_at: backup.updated_at,
      remote_file_id: jsonFile.id,
      remote_mp3_file_id: mp3File.id,
    })

    notification.clipsChanged.push(backup.id)
    console.log(`Downloaded clip: ${backup.id}`)
  }

  private async deleteClipFromRemote(clipId: string, result: SyncResult): Promise<void> {
    try {
      const remoteFiles = await googleDriveService.listFiles('clips')
      const filesToDelete = remoteFiles.filter(f => {
        const parsed = parseFilename(f.name)
        return parsed && parsed.type === 'clip' && parsed.id === clipId
      })

      for (const file of filesToDelete) {
        await googleDriveService.deleteFile(file.id)
      }

      // Clean up manifest
      databaseService.deleteManifestEntry('clip', clipId)

      if (filesToDelete.length > 0) {
        result.deleted.clips++
        console.log(`Deleted clip from remote: ${clipId}`)
      }
    } catch (error) {
      result.errors.push(`Failed to delete clip ${clipId} from Drive: ${error}`)
    }
  }

  private async mergeClip(
    local: Clip,
    remote: { file: DriveFile; timestamp: number },
    allFiles: DriveFile[],
    result: SyncResult
  ): Promise<Clip> {
    // Download remote version
    const content = await googleDriveService.downloadFile(remote.file.id, false) as string
    const remoteBackup: ClipBackup = JSON.parse(content)

    // Merge strategy:
    // - note: concatenate with conflict marker if different
    // - start, duration: last-write-wins
    // - transcription: prefer non-null
    const localWins = local.updated_at >= remoteBackup.updated_at

    let mergedNote = local.note
    if (local.note !== remoteBackup.note && remoteBackup.note) {
      // Both have notes and they're different - concatenate
      const timestamp = new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
      mergedNote = `${local.note}\n\n--- Conflict (${timestamp}) ---\n${remoteBackup.note}`
    }

    const merged: Clip = {
      ...local,
      note: mergedNote,
      start: localWins ? local.start : remoteBackup.start,
      duration: localWins ? local.duration : remoteBackup.duration,
      transcription: local.transcription || remoteBackup.transcription,
      updated_at: Date.now(),
    }

    // Update local database with merged result
    databaseService.restoreClipFromBackup(
      merged.id,
      merged.source_id,
      merged.uri,
      merged.start,
      merged.duration,
      merged.note,
      merged.transcription,
      merged.created_at,
      merged.updated_at
    )

    result.conflicts.push({
      entityType: 'clip',
      entityId: local.id,
      resolution: local.note !== remoteBackup.note
        ? 'Notes concatenated with conflict marker'
        : `Bounds: ${localWins ? 'local' : 'remote'} wins`,
    })

    console.log(`Merged clip conflict: ${local.id}`)
    return merged
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private groupRemoteFiles(
    files: DriveFile[],
    type: 'book' | 'clip'
  ): Map<string, { file: DriveFile; timestamp: number }> {
    const grouped = new Map<string, { file: DriveFile; timestamp: number }>()

    for (const file of files) {
      const parsed = parseFilename(file.name)
      if (!parsed || parsed.type !== type || parsed.extension !== 'json') continue

      // Use modifiedTime from Drive as timestamp, fall back to 0
      const timestamp = file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0

      grouped.set(parsed.id, { file, timestamp })
    }

    return grouped
  }
}

// ---------------------------------------------------------------------------
// Filename parsing
// ---------------------------------------------------------------------------

function parseFilename(name: string): ParsedFilename | null {
  const match = name.match(FILENAME_REGEX)
  if (!match) return null

  return {
    type: match[1] as 'book' | 'clip',
    id: match[2],
    extension: match[3] as 'json' | 'mp3',
  }
}

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const backupSyncService = new BackupSyncService()
