/**
 * Backup Sync Service
 *
 * Orchestrates incremental synchronization between local database and Google Drive.
 *
 * Architecture:
 * - State gathering: Collect local entities, remote files, and manifest entries
 * - Planning: Pure function determines what operations are needed (planner.ts)
 * - Execution: Perform uploads, downloads, merges, and deletes
 * - Merge logic: Pure functions resolve conflicts (merge.ts)
 */

import RNFS from 'react-native-fs'
import { DatabaseService, Book, Clip, SyncManifestEntry } from '../storage'
import { GoogleDriveService, DriveFile } from './drive'
import { GoogleAuthService } from './auth'
import { OfflineQueueService } from './queue'
import {
  BookBackup,
  ClipBackup,
  SyncResult,
  SyncNotification,
  SyncStatus,
  SyncListeners,
} from './types'
import {
  SyncState,
  SyncPlan,
  RemoteBook,
  RemoteClip,
  planSync,
} from './planner'
import { mergeBook, mergeClip } from './merge'

// Re-export types for external consumers
export * from './types'

// Filename format: {type}_{id}.{ext}
const FILENAME_REGEX = /^(book|clip)_([a-f0-9-]+)\.(json|mp3)$/

interface ParsedFilename {
  type: 'book' | 'clip'
  id: string
  extension: 'json' | 'mp3'
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export class BackupSyncService {
  private db: DatabaseService
  private drive: GoogleDriveService
  private auth: GoogleAuthService
  private queue: OfflineQueueService
  private listeners: SyncListeners
  private isSyncing = false

  constructor(
    db: DatabaseService,
    drive: GoogleDriveService,
    auth: GoogleAuthService,
    queue: OfflineQueueService,
    listeners: SyncListeners = {}
  ) {
    this.db = db
    this.drive = drive
    this.auth = auth
    this.queue = queue
    this.listeners = listeners
  }

  getPendingCount(): number {
    return this.queue.getCount()
  }

  /**
   * Manual sync with user authentication prompts if needed.
   */
  async syncNow(): Promise<void> {
    if (this.isSyncing) return
    this.isSyncing = true  // Set immediately to prevent race conditions

    this.setStatus(true, null)

    try {
      await this.auth.initialize()

      if (!this.auth.isAuthenticated()) {
        const signedIn = await this.auth.signIn()
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
   */
  async autoSync(): Promise<void> {
    if (this.isSyncing) return
    this.isSyncing = true  // Set immediately to prevent race conditions

    await this.auth.initialize()
    if (!this.auth.isAuthenticated()) {
      this.isSyncing = false
      return
    }

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

  // ---------------------------------------------------------------------------
  // Core Sync Flow
  // ---------------------------------------------------------------------------

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
      // 1. Process offline queue first (push queued changes)
      await this.processQueue(result)

      // 2. Gather state
      const state = await this.gatherSyncState()

      // 3. Plan sync operations (pure function)
      const plan = planSync(state)

      // 4. Execute plan
      await this.executePlan(plan, state, result, notification)

      // 5. Update last sync time
      this.db.setLastSyncTime(Date.now())

      // 6. Notify store of external changes
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
  // State Gathering
  // ---------------------------------------------------------------------------

  private async gatherSyncState(): Promise<SyncState> {
    // Fetch local data
    const localBooks = this.db.getAllBooks()
    const localClips = this.db.getAllClips()

    // Fetch remote data
    const remoteBookFiles = await this.drive.listFiles('books')
    const remoteClipFiles = await this.drive.listFiles('clips')

    // Download and parse remote backups
    const remoteBooks = await this.parseRemoteBooks(remoteBookFiles)
    const remoteClips = await this.parseRemoteClips(remoteClipFiles)

    // Gather manifests
    const allManifests = this.db.getAllManifestEntries()
    const manifests = new Map<string, SyncManifestEntry>()
    for (const m of allManifests) {
      manifests.set(`${m.entity_type}:${m.entity_id}`, m)
    }

    return {
      local: { books: localBooks, clips: localClips },
      remote: { books: remoteBooks, clips: remoteClips },
      manifests,
    }
  }

  private async parseRemoteBooks(files: DriveFile[]): Promise<Map<string, RemoteBook>> {
    const result = new Map<string, RemoteBook>()

    for (const file of files) {
      const parsed = parseFilename(file.name)
      if (!parsed || parsed.type !== 'book' || parsed.extension !== 'json') continue

      try {
        const content = await this.drive.downloadFile(file.id, false) as string
        const backup: BookBackup = JSON.parse(content)
        const modifiedAt = file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0

        result.set(parsed.id, { backup, fileId: file.id, modifiedAt })
      } catch (error) {
        console.warn(`Failed to parse remote book ${file.name}:`, error)
      }
    }

    return result
  }

  private async parseRemoteClips(files: DriveFile[]): Promise<Map<string, RemoteClip>> {
    const result = new Map<string, RemoteClip>()

    // Group files by clip ID
    const filesByClipId = new Map<string, { json?: DriveFile; mp3?: DriveFile }>()
    for (const file of files) {
      const parsed = parseFilename(file.name)
      if (!parsed || parsed.type !== 'clip') continue

      const existing = filesByClipId.get(parsed.id) ?? {}
      if (parsed.extension === 'json') existing.json = file
      if (parsed.extension === 'mp3') existing.mp3 = file
      filesByClipId.set(parsed.id, existing)
    }

    // Parse JSON files
    for (const [clipId, { json, mp3 }] of filesByClipId) {
      if (!json || !mp3) continue // Need both files

      try {
        const content = await this.drive.downloadFile(json.id, false) as string
        const backup: ClipBackup = JSON.parse(content)
        const modifiedAt = json.modifiedTime ? new Date(json.modifiedTime).getTime() : 0

        result.set(clipId, {
          backup,
          jsonFileId: json.id,
          mp3FileId: mp3.id,
          modifiedAt,
        })
      } catch (error) {
        console.warn(`Failed to parse remote clip ${json.name}:`, error)
      }
    }

    return result
  }

  // ---------------------------------------------------------------------------
  // Plan Execution
  // ---------------------------------------------------------------------------

  private async executePlan(
    plan: SyncPlan,
    state: SyncState,
    result: SyncResult,
    notification: SyncNotification
  ): Promise<void> {
    // Execute book operations
    for (const { local, remote } of plan.books.merges) {
      await this.executeMergeBook(local, remote, result)
    }
    for (const { book } of plan.books.uploads) {
      await this.executeUploadBook(book, result)
    }
    for (const { remote } of plan.books.downloads) {
      await this.executeDownloadBook(remote, notification)
      result.downloaded.books++
    }

    // Execute clip operations
    for (const { local, remote } of plan.clips.merges) {
      await this.executeMergeClip(local, remote, result)
    }
    for (const { clip } of plan.clips.uploads) {
      await this.executeUploadClip(clip, result)
    }
    for (const { remote } of plan.clips.downloads) {
      await this.executeDownloadClip(remote, notification)
      result.downloaded.clips++
    }
    for (const del of plan.clips.deletes) {
      await this.executeDeleteClip(del.clipId, del.jsonFileId, del.mp3FileId, result)
    }

    // Clean up orphaned manifest entries
    this.cleanupManifests(state)
  }

  // ---------------------------------------------------------------------------
  // Book Execution
  // ---------------------------------------------------------------------------

  private async executeMergeBook(local: Book, remote: RemoteBook, result: SyncResult): Promise<void> {
    const { merged, resolution } = mergeBook(local, remote.backup)

    // Update local database with merged result
    this.db.restoreBookFromBackup(
      merged.id,
      merged.name,
      merged.duration,
      merged.position,
      merged.updated_at,
      merged.title,
      merged.artist,
      merged.artwork,
      merged.file_size,
      merged.fingerprint,
      merged.hidden
    )

    // Upload merged result
    await this.executeUploadBook(merged, result)

    result.conflicts.push({
      entityType: 'book',
      entityId: local.id,
      resolution,
    })

    console.log(`Merged book conflict: ${local.id}`)
  }

  private async executeUploadBook(book: Book, result: SyncResult): Promise<void> {
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
        hidden: book.hidden,
      }

      const filename = `book_${book.id}.json`
      const content = JSON.stringify(backup, null, 2)

      // Delete existing file first
      const remoteFiles = await this.drive.listFiles('books')
      const existingFile = remoteFiles.find(f => f.name === filename)
      if (existingFile) {
        await this.drive.deleteFile(existingFile.id)
      }

      const uploaded = await this.drive.uploadFile('books', filename, content)

      // Update manifest
      this.db.upsertManifestEntry({
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

  private async executeDownloadBook(remote: RemoteBook, notification: SyncNotification): Promise<void> {
    const backup = remote.backup

    this.db.restoreBookFromBackup(
      backup.id,
      backup.name,
      backup.duration,
      backup.position,
      backup.updated_at,
      backup.title,
      backup.artist,
      backup.artwork,
      backup.file_size,
      base64ToUint8Array(backup.fingerprint),
      backup.hidden ?? false  // Backward compat: old backups may not have hidden field
    )

    // Update manifest
    this.db.upsertManifestEntry({
      entity_type: 'book',
      entity_id: backup.id,
      local_updated_at: backup.updated_at,
      remote_updated_at: backup.updated_at,
      remote_file_id: remote.fileId,
      remote_mp3_file_id: null,
    })

    notification.booksChanged.push(backup.id)
    console.log(`Downloaded book: ${backup.id}`)
  }

  // ---------------------------------------------------------------------------
  // Clip Execution
  // ---------------------------------------------------------------------------

  private async executeMergeClip(local: Clip, remote: RemoteClip, result: SyncResult): Promise<void> {
    const { merged, resolution } = mergeClip(local, remote.backup)

    // Update local database with merged result
    this.db.restoreClipFromBackup(
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

    // Upload merged result
    await this.executeUploadClip(merged, result)

    result.conflicts.push({
      entityType: 'clip',
      entityId: local.id,
      resolution,
    })

    console.log(`Merged clip conflict: ${local.id}`)
  }

  private async executeUploadClip(clip: Clip, result: SyncResult): Promise<void> {
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
      const remoteFiles = await this.drive.listFiles('clips')
      const existingJson = remoteFiles.find(f => f.name === jsonFilename)
      const existingMp3 = remoteFiles.find(f => f.name === mp3Filename)

      if (existingJson) await this.drive.deleteFile(existingJson.id)
      if (existingMp3) await this.drive.deleteFile(existingMp3.id)

      // Upload JSON first
      const jsonContent = JSON.stringify(backup, null, 2)
      const jsonFile = await this.drive.uploadFile('clips', jsonFilename, jsonContent)
      jsonFileId = jsonFile.id

      // Upload MP3 (with size check to prevent OOM)
      const clipPath = clip.uri.replace('file://', '')
      const fileStat = await RNFS.stat(clipPath)
      const MAX_CLIP_SIZE = 50 * 1024 * 1024  // 50MB limit
      if (fileStat.size > MAX_CLIP_SIZE) {
        throw new Error(`Clip file too large (${Math.round(fileStat.size / 1024 / 1024)}MB). Max: 50MB`)
      }
      const mp3Content = await RNFS.readFile(clipPath, 'base64')
      const mp3Bytes = base64ToUint8Array(mp3Content)
      const mp3File = await this.drive.uploadFile('clips', mp3Filename, mp3Bytes)
      mp3FileId = mp3File.id

      // Update manifest
      this.db.upsertManifestEntry({
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
      // Rollback: if JSON uploaded but MP3 failed, delete JSON to prevent orphans
      if (jsonFileId && !mp3FileId) {
        let rollbackSuccess = false
        for (let attempt = 0; attempt < 3 && !rollbackSuccess; attempt++) {
          try {
            await this.drive.deleteFile(jsonFileId)
            rollbackSuccess = true
          } catch (rollbackError) {
            console.warn(`Rollback attempt ${attempt + 1} failed:`, rollbackError)
          }
        }
        if (!rollbackSuccess) {
          result.errors.push(`Orphaned JSON file on Drive: ${jsonFilename}`)
        }
      }
      result.errors.push(`Failed to upload clip ${clip.id}: ${error}`)
    }
  }

  private async executeDownloadClip(remote: RemoteClip, notification: SyncNotification): Promise<void> {
    const backup = remote.backup

    // Download MP3
    const mp3Bytes = await this.drive.downloadFile(remote.mp3FileId, true) as Uint8Array

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
    this.db.restoreClipFromBackup(
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
    this.db.upsertManifestEntry({
      entity_type: 'clip',
      entity_id: backup.id,
      local_updated_at: backup.updated_at,
      remote_updated_at: backup.updated_at,
      remote_file_id: remote.jsonFileId,
      remote_mp3_file_id: remote.mp3FileId,
    })

    notification.clipsChanged.push(backup.id)
    console.log(`Downloaded clip: ${backup.id}`)
  }

  private async executeDeleteClip(
    clipId: string,
    jsonFileId: string | null,
    mp3FileId: string | null,
    result: SyncResult
  ): Promise<void> {
    try {
      if (jsonFileId) await this.drive.deleteFile(jsonFileId)
      if (mp3FileId) await this.drive.deleteFile(mp3FileId)

      // Clean up manifest
      this.db.deleteManifestEntry('clip', clipId)

      result.deleted.clips++
      console.log(`Deleted clip from remote: ${clipId}`)
    } catch (error) {
      result.errors.push(`Failed to delete clip ${clipId} from Drive: ${error}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Queue Processing (for offline changes)
  // ---------------------------------------------------------------------------

  private async processQueue(result: SyncResult): Promise<void> {
    const processResult = await this.queue.processQueue(async (item) => {
      if (item.entity_type === 'book' && item.operation === 'upsert') {
        const book = this.db.getBookById(item.entity_id)
        if (book) await this.executeUploadBook(book, result)
      } else if (item.entity_type === 'clip') {
        if (item.operation === 'upsert') {
          const clip = this.db.getClip(item.entity_id)
          if (clip) await this.executeUploadClip(clip, result)
        } else if (item.operation === 'delete') {
          // Find remote files to delete
          const remoteFiles = await this.drive.listFiles('clips')
          const jsonFile = remoteFiles.find(f => f.name === `clip_${item.entity_id}.json`)
          const mp3File = remoteFiles.find(f => f.name === `clip_${item.entity_id}.mp3`)
          await this.executeDeleteClip(
            item.entity_id,
            jsonFile?.id ?? null,
            mp3File?.id ?? null,
            result
          )
        }
      }
    })

    if (processResult.errors.length > 0) {
      result.errors.push(...processResult.errors.map(e => `Queue: ${e}`))
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  private cleanupManifests(state: SyncState): void {
    const localBookIds = new Set(state.local.books.map(b => b.id))
    const localClipIds = new Set(state.local.clips.map(c => c.id))

    for (const [key, manifest] of state.manifests) {
      const existsLocally = manifest.entity_type === 'book'
        ? localBookIds.has(manifest.entity_id)
        : localClipIds.has(manifest.entity_id)

      const existsRemotely = manifest.entity_type === 'book'
        ? state.remote.books.has(manifest.entity_id)
        : state.remote.clips.has(manifest.entity_id)

      if (!existsLocally && !existsRemotely) {
        this.db.deleteManifestEntry(manifest.entity_type, manifest.entity_id)
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Filename Parsing
// -----------------------------------------------------------------------------

function parseFilename(name: string): ParsedFilename | null {
  const match = name.match(FILENAME_REGEX)
  if (!match) return null

  return {
    type: match[1] as 'book' | 'clip',
    id: match[2],
    extension: match[3] as 'json' | 'mp3',
  }
}

// -----------------------------------------------------------------------------
// Base64 Helpers
// -----------------------------------------------------------------------------

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
