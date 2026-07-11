/**
 * Backup Sync Service
 *
 * Incremental sync engine using Drive's changes.list API.
 *
 * Architecture:
 * - Pull: Drive change feed since last page token → per-entity LWW reconciliation
 * - Push: Drain local outbox → upload with stale detection
 * - Transport: Update-in-place uploads preserve Drive file IDs
 */

import RNFS from 'react-native-fs'
import { DatabaseService, Book, Clip, Session, SyncOutboxItem } from '../storage'
import { GoogleDriveService, DriveFile, DriveApiError, BackupFolder } from './drive'
import { GoogleAuthService } from './auth'
import { BaseService } from '../base'
import {
  BookBackup,
  ClipBackup,
  SessionBackup,
  SyncResult,
  SyncNotification,
  SyncStatus,
} from './types'
import { createLogger } from '../../utils'

const log = createLogger('Sync')

// Re-export types for external consumers
export * from './types'

// Filename format: {type}_{uuid}.{ext}
const FILENAME_REGEX = /^(book|clip|session)_([a-f0-9-]+)\.(json|mp3|m4a)$/

interface ParsedFilename {
  type: 'book' | 'clip' | 'session'
  id: string
  extension: 'json' | 'mp3' | 'm4a'
}

// A single entry from Drive's change feed
type RemoteChange = { fileId: string; removed: boolean; file?: DriveFile }

export type BackupSyncEvents = {
  status: SyncStatus
  data: SyncNotification
}

// Max upload size for clip audio (50MB)
const MAX_CLIP_SIZE = 50 * 1024 * 1024

// Push retry backoff: 30s doubling per attempt, capped at 6 hours
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000

// Pull-side poison pill: consecutive reconcile failures after which an
// entity's errors stop blocking token advance (it keeps retrying each sync)
const QUARANTINE_THRESHOLD = 5

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export class BackupSyncService extends BaseService<BackupSyncEvents> {
  private db: DatabaseService
  private drive: GoogleDriveService
  private auth: GoogleAuthService
  private isSyncing = false

  // Pull-side poison-pill tracking. In-memory by design: an app restart resets
  // it, which only costs a few extra token-holding retries before an entity
  // re-quarantines — but a restarted app also forgets the retry list, so a
  // quarantined entity is not re-attempted until its next remote change or a
  // full reconcile.
  private pullFailures = new Map<string, number>()        // "type:id" → consecutive reconcile failures
  private quarantined = new Map<string, RemoteChange[]>() // "type:id" → last-seen changes, retried each sync

  constructor(
    db: DatabaseService,
    drive: GoogleDriveService,
    auth: GoogleAuthService,
  ) {
    super()
    this.db = db
    this.drive = drive
    this.auth = auth
  }

  async getPendingCount(): Promise<number> {
    return this.db.getQueueCount()
  }

  /**
   * Manual sync with user authentication prompts if needed.
   */
  async syncNow(): Promise<void> {
    if (this.isSyncing) return
    this.isSyncing = true

    await this.setStatus(true, null)

    try {
      await this.auth.initialize()

      if (!this.auth.isAuthenticated()) {
        const signedIn = await this.auth.signIn()
        if (!signedIn) {
          await this.setStatus(false, 'Could not sign in to Google')
          return
        }
      }

      const result = await this.performSync()

      if (result.errors.length > 0) {
        await this.setStatus(false, `${result.errors.length} error(s) occurred during sync`)
      } else {
        await this.setStatus(false, null)
      }
    } catch (error) {
      log('Sync failed:', error)
      await this.setStatus(false, String(error))
    }
  }

  /**
   * Silent background sync. Only runs if already authenticated.
   */
  async autoSync(): Promise<void> {
    if (this.isSyncing) return
    this.isSyncing = true

    const token = await this.auth.getAccessToken()
    if (!token) {
      this.isSyncing = false
      return
    }

    await this.setStatus(true, null)

    try {
      const result = await this.performSync()

      if (result.errors.length > 0) {
        log('Auto-sync errors:', result.errors)
        await this.setStatus(false, `${result.errors.length} error(s) occurred`)
      } else {
        await this.setStatus(false, null)
      }
    } catch (error) {
      log('Auto-sync failed:', error)
      await this.setStatus(false, String(error))
    }
  }

  private async setStatus(isSyncing: boolean, error: string | null): Promise<void> {
    this.isSyncing = isSyncing
    this.emit('status', {
      isSyncing,
      pendingCount: await this.getPendingCount(),
      error,
    })
  }

  // ---------------------------------------------------------------------------
  // Core Sync Flow
  // ---------------------------------------------------------------------------

  private async performSync(): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: { books: 0, clips: 0, sessions: 0 },
      downloaded: { books: 0, clips: 0, sessions: 0 },
      deleted: { clips: 0, sessions: 0 },
      errors: [],
    }

    const notification: SyncNotification = {
      booksChanged: [],
      clipsChanged: [],
      sessionsChanged: [],
    }

    try {
      // 1. Pull: process remote changes
      await this.pullRemoteChanges(result, notification)

      // 2. Push: drain local outbox
      await this.pushOutbox(result)

      // 3. Record sync time
      await this.db.setLastSyncTime(Date.now())

      // 4. Notify store of remote changes
      if (notification.booksChanged.length > 0 || notification.clipsChanged.length > 0 || notification.sessionsChanged.length > 0) {
        this.emit('data', notification)
      }
    } catch (error) {
      result.errors.push(`Sync failed: ${error}`)
    }

    log('Sync complete:', result)
    return result
  }

  // ---------------------------------------------------------------------------
  // Pull Phase: Drive Changes
  // ---------------------------------------------------------------------------

  private async pullRemoteChanges(result: SyncResult, notification: SyncNotification): Promise<void> {
    const checkpoint = this.db.getCheckpoint()
    let pageToken = checkpoint.last_page_token

    // First sync or recovery: get a start token and do a full reconcile
    if (!pageToken) {
      try {
        pageToken = await this.drive.getStartPageToken()
        await this.fullReconcile(result, notification)
        await this.db.setCheckpointPageToken(pageToken)
        return
      } catch (error) {
        result.errors.push(`Failed to initialize sync: ${error}`)
        return
      }
    }

    // Normal incremental pull
    try {
      const changesResult = await this.drive.getChanges(pageToken)

      // Group changes by Ivy entity
      const entityChanges = this.groupChangesByEntity(changesResult.changes)

      // Retry quarantined entities alongside fresh changes — their failures no
      // longer hold the token, so the feed won't re-deliver them on its own
      for (const [key, files] of this.quarantined) {
        if (!entityChanges.has(key)) entityChanges.set(key, files)
      }

      // Reconcile each changed entity
      let blockingFailures = 0
      for (const [key, files] of entityChanges) {
        const [type, id] = key.split(':') as ['book' | 'clip' | 'session', string]
        const errorsBefore = result.errors.length
        try {
          await this.reconcileEntity(type, id, files, result, notification)
        } catch (error) {
          result.errors.push(`Failed to reconcile ${type} ${id}: ${error}`)
        }

        // Failures are thrown or recorded directly in result.errors
        if (result.errors.length > errorsBefore) {
          const failures = (this.pullFailures.get(key) ?? 0) + 1
          this.pullFailures.set(key, failures)
          if (failures >= QUARANTINE_THRESHOLD) {
            log(`Quarantining ${key} after ${failures} consecutive reconcile failures`)
            this.quarantined.set(key, files)
          } else {
            blockingFailures++
          }
        } else {
          this.pullFailures.delete(key)
          this.quarantined.delete(key)
        }
      }

      // Only advance the token when every change reconciled — on failure the
      // token stays put so failed changes are re-delivered next sync
      // (re-processing already-reconciled entities is safe: same versions
      // short-circuit). Quarantined entities are the exception: a poison pill
      // must not freeze the token forever, so their failures don't block and
      // they retry from the in-memory list instead of the feed.
      const newToken = changesResult.newStartPageToken
      if (newToken && blockingFailures === 0) {
        await this.db.setCheckpointPageToken(newToken)
      }
    } catch (error: any) {
      // Invalid page token — trigger recovery (once only, not recursive)
      if (error.message?.includes('410')) {
        log('Page token expired (410), triggering full reconcile')
        await this.db.clearCheckpoint()
        const freshToken = await this.drive.getStartPageToken()
        await this.fullReconcile(result, notification)
        await this.db.setCheckpointPageToken(freshToken)
      } else {
        throw error
      }
    }
  }

  /**
   * Group Drive changes by Ivy entity.
   * Returns a map of "type:id" → changed DriveFiles.
   */
  private groupChangesByEntity(
    changes: Array<{ fileId: string; removed: boolean; file?: DriveFile }>
  ): Map<string, Array<{ fileId: string; removed: boolean; file?: DriveFile }>> {
    const groups = new Map<string, Array<{ fileId: string; removed: boolean; file?: DriveFile }>>()

    for (const change of changes) {
      const filename = change.file?.name
      if (!filename) {
        // Removed files don't include metadata — skip (can't map to entity without name)
        continue
      }

      const parsed = parseFilename(filename)
      if (!parsed) continue

      const key = `${parsed.type}:${parsed.id}`
      const existing = groups.get(key) ?? []
      existing.push(change)
      groups.set(key, existing)
    }

    return groups
  }

  // ---------------------------------------------------------------------------
  // Per-Entity Reconciliation
  // ---------------------------------------------------------------------------

  private async reconcileEntity(
    type: 'book' | 'clip' | 'session',
    id: string,
    remoteChanges: Array<{ fileId: string; removed: boolean; file?: DriveFile }>,
    result: SyncResult,
    notification: SyncNotification,
  ): Promise<void> {
    // Check if all changes are removals
    const allRemoved = remoteChanges.every(c => c.removed)
    if (allRemoved) {
      // Remote file was deleted — nothing to pull
      return
    }

    switch (type) {
      case 'book':
        await this.reconcileBook(id, remoteChanges, result, notification)
        break
      case 'clip':
        await this.reconcileClip(id, remoteChanges, result, notification)
        break
      case 'session':
        await this.reconcileSession(id, remoteChanges, result, notification)
        break
    }
  }

  private async reconcileBook(
    id: string,
    remoteChanges: Array<{ fileId: string; removed: boolean; file?: DriveFile }>,
    result: SyncResult,
    notification: SyncNotification,
  ): Promise<void> {
    // Find the JSON file change
    const jsonChange = remoteChanges.find(c => c.file?.name?.endsWith('.json'))
    if (!jsonChange?.file) return

    // Download and parse remote
    const content = await this.drive.downloadFile(jsonChange.fileId, false) as string
    const remote: BookBackup = JSON.parse(content)

    // Read local
    const local = await this.db.getBookById(id)

    if (!local) {
      // New remotely — download
      await this.downloadBook(remote, jsonChange.fileId, result, notification)
      return
    }

    // LWW reconciliation
    if (this.isSameVersion(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) {
      // Already in sync — just ensure manifest has the file ID
      await this.db.upsertManifestEntry({
        entity_type: 'book', entity_id: id,
        local_updated_at: local.updated_at, remote_updated_at: null,
        remote_file_id: jsonChange.fileId, remote_audio_file_id: null,
      })
    } else if (this.isRemoteAhead(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) {
      await this.downloadBook(remote, jsonChange.fileId, result, notification)
    } else {
      await this.db.queueChange('book', id, 'upsert', local.updated_at)
    }
  }

  private async reconcileClip(
    id: string,
    remoteChanges: Array<{ fileId: string; removed: boolean; file?: DriveFile }>,
    result: SyncResult,
    notification: SyncNotification,
  ): Promise<void> {
    const jsonChange = remoteChanges.find(c => c.file?.name?.endsWith('.json'))
    const audioChange = remoteChanges.find(c => {
      const name = c.file?.name
      return name && (name.endsWith('.m4a') || name.endsWith('.mp3'))
    })

    if (!jsonChange?.file) return

    const content = await this.drive.downloadFile(jsonChange.fileId, false) as string
    const remote: ClipBackup = JSON.parse(content)

    // Tombstone: branch before any audio handling or restore call
    if (remote.deleted) {
      await this.applyClipTombstone(remote, jsonChange.fileId, result, notification)
      return
    }

    const local = await this.db.getClip(id)

    if (!local) {
      // New remotely — need audio file ID (from change or manifest)
      const audioFileId = audioChange?.fileId ?? (await this.db.getManifestEntry('clip', id))?.remote_audio_file_id
      const audioFilename = audioChange?.file?.name
      if (audioFileId) {
        await this.downloadClip(remote, jsonChange.fileId, audioFileId, audioFilename, result, notification)
      } else {
        result.errors.push(`Clip ${id}: no audio file found`)
      }
      return
    }

    if (this.isSameVersion(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) {
      // Already in sync
    } else if (this.isRemoteAhead(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) {
      const audioFileId = audioChange?.fileId ?? (await this.db.getManifestEntry('clip', id))?.remote_audio_file_id
      const audioFilename = audioChange?.file?.name
      if (audioFileId) {
        await this.downloadClip(remote, jsonChange.fileId, audioFileId, audioFilename, result, notification)
      }
    } else {
      await this.db.queueChange('clip', id, 'upsert', local.updated_at)
    }
  }

  private async reconcileSession(
    id: string,
    remoteChanges: Array<{ fileId: string; removed: boolean; file?: DriveFile }>,
    result: SyncResult,
    notification: SyncNotification,
  ): Promise<void> {
    const jsonChange = remoteChanges.find(c => c.file?.name?.endsWith('.json'))
    if (!jsonChange?.file) return

    const content = await this.drive.downloadFile(jsonChange.fileId, false) as string
    const remote: SessionBackup = JSON.parse(content)

    // Tombstone: branch before any restore call
    if (remote.deleted) {
      await this.applySessionTombstone(remote, jsonChange.fileId, result, notification)
      return
    }

    const local = await this.db.getSessionById(id)

    if (!local) {
      await this.downloadSession(remote, jsonChange.fileId, result, notification)
      return
    }

    if (this.isSameVersion(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) {
      // Already in sync
    } else if (this.isRemoteAhead(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) {
      await this.downloadSession(remote, jsonChange.fileId, result, notification)
    } else {
      await this.db.queueChange('session', id, 'upsert', local.updated_at)
    }
  }

  // ---------------------------------------------------------------------------
  // Version Comparison
  // ---------------------------------------------------------------------------

  private isSameVersion(
    localUpdatedAt: number, localUpdatedBy: string | null,
    remoteUpdatedAt: number, remoteUpdatedBy: string | null,
  ): boolean {
    return localUpdatedAt === remoteUpdatedAt && (localUpdatedBy ?? '') === (remoteUpdatedBy ?? '')
  }

  private isRemoteAhead(
    localUpdatedAt: number, localUpdatedBy: string | null,
    remoteUpdatedAt: number, remoteUpdatedBy: string | null,
  ): boolean {
    if (localUpdatedAt !== remoteUpdatedAt) return remoteUpdatedAt > localUpdatedAt
    // Same timestamp — check device ID tie-breaker
    return (remoteUpdatedBy ?? '') > (localUpdatedBy ?? '')
  }

  // ---------------------------------------------------------------------------
  // Download (Apply Remote → Local)
  // ---------------------------------------------------------------------------

  private async downloadBook(
    remote: BookBackup,
    remoteFileId: string,
    result: SyncResult,
    notification: SyncNotification,
  ): Promise<void> {
    const fingerprint = base64ToUint8Array(remote.fingerprint)

    // Duplicate detection via fingerprint
    const existing = await this.db.getBookByFingerprint(remote.file_size, fingerprint)
    if (existing && existing.id !== remote.id) {
      log(`Skipping download of book ${remote.id}: fingerprint matches ${existing.id}`)
      return
    }

    await this.db.restoreBookFromBackup(
      remote.id, remote.name, remote.duration, remote.position,
      remote.updated_at, remote.updated_by ?? null,
      remote.title, remote.artist, remote.artwork,
      remote.file_size, fingerprint,
      remote.speed ?? 100,
    )

    await this.db.upsertManifestEntry({
      entity_type: 'book', entity_id: remote.id,
      local_updated_at: remote.updated_at,
      remote_updated_at: null,
      remote_file_id: remoteFileId,
      remote_audio_file_id: null,
    })

    notification.booksChanged.push(remote.id)
    result.downloaded.books++
    log(`Downloaded book: ${remote.id}`)
  }

  private async downloadClip(
    remote: ClipBackup,
    jsonFileId: string,
    audioFileId: string,
    audioFilename: string | undefined,
    result: SyncResult,
    notification: SyncNotification,
  ): Promise<void> {
    const audioBytes = await this.drive.downloadFile(audioFileId, true) as Uint8Array

    const clipsDir = `${RNFS.DocumentDirectoryPath}/clips`
    if (!(await RNFS.exists(clipsDir))) {
      await RNFS.mkdir(clipsDir)
    }

    const ext = audioFilename?.split('.').pop() ?? 'm4a'
    const localPath = `${clipsDir}/${remote.id}.${ext}`
    await RNFS.writeFile(localPath, uint8ArrayToBase64(audioBytes), 'base64')

    const localUri = `file://${localPath}`

    await this.db.restoreClipFromBackup(
      remote.id, remote.source_id, localUri,
      remote.start, remote.duration, remote.note,
      remote.transcription, remote.created_at,
      remote.updated_at, remote.updated_by ?? null,
    )

    await this.db.upsertManifestEntry({
      entity_type: 'clip', entity_id: remote.id,
      local_updated_at: remote.updated_at,
      remote_updated_at: null,
      remote_file_id: jsonFileId,
      remote_audio_file_id: audioFileId,
    })

    notification.clipsChanged.push(remote.id)
    result.downloaded.clips++
    log(`Downloaded clip: ${remote.id}`)
  }

  private async downloadSession(
    remote: SessionBackup,
    remoteFileId: string,
    result: SyncResult,
    notification: SyncNotification,
  ): Promise<void> {
    await this.db.restoreSessionFromBackup(
      remote.id, remote.book_id,
      remote.started_at, remote.ended_at,
      remote.updated_at, remote.updated_by ?? null,
    )

    await this.db.upsertManifestEntry({
      entity_type: 'session', entity_id: remote.id,
      local_updated_at: remote.updated_at,
      remote_updated_at: null,
      remote_file_id: remoteFileId,
      remote_audio_file_id: null,
    })

    notification.sessionsChanged.push(remote.id)
    result.downloaded.sessions++
    log(`Downloaded session: ${remote.id}`)
  }

  // ---------------------------------------------------------------------------
  // Apply Remote Tombstones
  // ---------------------------------------------------------------------------

  /**
   * Apply a remote clip tombstone under LWW. Tombstone wins → delete the local
   * row and audio file; a newer local edit wins → keep it and re-upload
   * (un-delete). No local row (already deleted, or a device's own tombstone
   * echoing back through the change feed) is a no-op.
   *
   * Either way the remote audio file is gone, so the manifest's audio id is
   * nulled — the next upload creates a fresh audio file instead of updating a
   * dead id.
   */
  private async applyClipTombstone(
    remote: ClipBackup,
    jsonFileId: string,
    result: SyncResult,
    notification: SyncNotification,
  ): Promise<void> {
    const local = await this.db.getClip(remote.id)
    if (!local) return

    if (this.isSameVersion(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) return

    if (this.isRemoteAhead(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) {
      await RNFS.unlink(local.uri.replace('file://', '')).catch(() => {})
      await this.db.deleteClip(remote.id)
      await this.db.upsertManifestEntry({
        entity_type: 'clip', entity_id: remote.id,
        local_updated_at: remote.updated_at, remote_updated_at: null,
        remote_file_id: jsonFileId, remote_audio_file_id: null,
      })
      notification.clipsChanged.push(remote.id)
      result.deleted.clips++
      log(`Applied clip tombstone: ${remote.id}`)
    } else {
      // Local edit is newer — it wins and re-uploads the live entity (un-delete)
      await this.db.upsertManifestEntry({
        entity_type: 'clip', entity_id: remote.id,
        local_updated_at: local.updated_at, remote_updated_at: null,
        remote_file_id: jsonFileId, remote_audio_file_id: null,
      })
      await this.db.queueChange('clip', remote.id, 'upsert', local.updated_at)
    }
  }

  /**
   * Apply a remote session tombstone under LWW (same as clips, minus audio).
   */
  private async applySessionTombstone(
    remote: SessionBackup,
    jsonFileId: string,
    result: SyncResult,
    notification: SyncNotification,
  ): Promise<void> {
    const local = await this.db.getSessionById(remote.id)
    if (!local) return

    if (this.isSameVersion(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) return

    if (this.isRemoteAhead(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) {
      await this.db.deleteSession(remote.id)
      await this.db.upsertManifestEntry({
        entity_type: 'session', entity_id: remote.id,
        local_updated_at: remote.updated_at, remote_updated_at: null,
        remote_file_id: jsonFileId, remote_audio_file_id: null,
      })
      notification.sessionsChanged.push(remote.id)
      result.deleted.sessions++
      log(`Applied session tombstone: ${remote.id}`)
    } else {
      await this.db.upsertManifestEntry({
        entity_type: 'session', entity_id: remote.id,
        local_updated_at: local.updated_at, remote_updated_at: null,
        remote_file_id: jsonFileId, remote_audio_file_id: null,
      })
      await this.db.queueChange('session', remote.id, 'upsert', local.updated_at)
    }
  }

  // ---------------------------------------------------------------------------
  // Push Phase: Drain Outbox
  // ---------------------------------------------------------------------------

  private async pushOutbox(result: SyncResult): Promise<void> {
    const items = await this.db.getOutboxItems(Date.now())

    for (const item of items) {
      try {
        await this.pushOutboxItem(item, result)
        await this.db.removeOutboxItem(item.entity_type, item.entity_id, item.updated_at_when_queued)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        const backoff = Math.min(2 ** item.attempts * BACKOFF_BASE_MS, BACKOFF_MAX_MS)
        await this.db.updateOutboxItemAttempt(
          item.entity_type, item.entity_id, msg,
          Date.now() + backoff, item.updated_at_when_queued,
        )
        result.errors.push(`Push ${item.entity_type}:${item.entity_id}: ${msg}`)
      }
    }
  }

  private async pushOutboxItem(item: SyncOutboxItem, result: SyncResult): Promise<void> {
    switch (item.entity_type) {
      case 'book':
        // Books are per-device: deletion never syncs, only upserts are queued
        if (item.operation === 'upsert') {
          const book = await this.db.getBookById(item.entity_id)
          if (book) await this.uploadBook(book, item, result)
        }
        break
      case 'clip':
        if (item.operation === 'upsert') {
          const clip = await this.db.getClip(item.entity_id)
          if (clip) await this.uploadClip(clip, item, result)
        } else if (item.operation === 'delete') {
          await this.tombstoneRemoteClip(item, result)
        }
        break
      case 'session':
        if (item.operation === 'upsert') {
          const session = await this.db.getSessionById(item.entity_id)
          if (session) await this.uploadSession(session, item, result)
        } else if (item.operation === 'delete') {
          await this.tombstoneRemoteSession(item, result)
        }
        break
    }
  }

  // ---------------------------------------------------------------------------
  // Upload (Push Local → Remote)
  // ---------------------------------------------------------------------------

  /**
   * Update a remote file in place, falling back to create-new when the remote
   * id is dead (404 — user cleanup, trash purge). The caller records the
   * returned id in its manifest entry, healing the dead reference.
   */
  private async updateOrRecreateFile(
    fileId: string,
    folder: BackupFolder,
    filename: string,
    content: string | Uint8Array,
  ): Promise<DriveFile> {
    try {
      return await this.drive.updateFile(fileId, content)
    } catch (error) {
      if (!(error instanceof DriveApiError) || error.status !== 404) throw error
      log(`Remote file ${fileId} for ${filename} is gone (404) — creating anew`)
      return this.drive.uploadFile(folder, filename, content)
    }
  }

  private async uploadBook(book: Book, outboxItem: SyncOutboxItem, result: SyncResult): Promise<void> {
    const backup: BookBackup = {
      id: book.id,
      name: book.name,
      duration: book.duration,
      position: book.position,
      updated_at: book.updated_at,
      updated_by: book.updated_by,
      title: book.title,
      artist: book.artist,
      artwork: book.artwork,
      file_size: book.file_size,
      fingerprint: uint8ArrayToBase64(book.fingerprint),
      speed: book.speed,
    }

    const filename = `book_${book.id}.json`
    const content = JSON.stringify(backup, null, 2)

    const manifest = await this.db.getManifestEntry('book', book.id)
    const uploaded = manifest?.remote_file_id
      ? await this.updateOrRecreateFile(manifest.remote_file_id, 'books', filename, content)
      : await this.drive.uploadFile('books', filename, content)

    await this.db.upsertManifestEntry({
      entity_type: 'book', entity_id: book.id,
      local_updated_at: book.updated_at,
      remote_updated_at: null,
      remote_file_id: uploaded.id,
      remote_audio_file_id: null,
    })

    // Stale check: if entity was modified during upload, re-queue
    const fresh = await this.db.getBookById(book.id)
    if (fresh && fresh.updated_at > outboxItem.updated_at_when_queued) {
      await this.db.queueChange('book', book.id, 'upsert', fresh.updated_at)
      log(`Book ${book.id} was modified during upload, re-queued`)
    }

    result.uploaded.books++
    log(`Uploaded book: ${book.id}`)
  }

  private async uploadClip(clip: Clip, outboxItem: SyncOutboxItem, result: SyncResult): Promise<void> {
    const backup: ClipBackup = {
      id: clip.id,
      source_id: clip.source_id,
      start: clip.start,
      duration: clip.duration,
      note: clip.note,
      transcription: clip.transcription,
      created_at: clip.created_at,
      updated_at: clip.updated_at,
      updated_by: clip.updated_by,
    }

    const jsonFilename = `clip_${clip.id}.json`
    const ext = clip.uri.split('.').pop() ?? 'm4a'
    const audioFilename = `clip_${clip.id}.${ext}`
    const jsonContent = JSON.stringify(backup, null, 2)

    const manifest = await this.db.getManifestEntry('clip', clip.id)

    // Upload JSON (update or create)
    const jsonFile = manifest?.remote_file_id
      ? await this.updateOrRecreateFile(manifest.remote_file_id, 'clips', jsonFilename, jsonContent)
      : await this.drive.uploadFile('clips', jsonFilename, jsonContent)

    // Upload audio (update or create, with size check)
    let audioFile
    try {
      const audioFileId = manifest?.remote_audio_file_id
      const clipPath = clip.uri.replace('file://', '')
      const fileStat = await RNFS.stat(clipPath)
      if (fileStat.size > MAX_CLIP_SIZE) {
        throw new Error(`Clip file too large (${Math.round(fileStat.size / 1024 / 1024)}MB). Max: 50MB`)
      }

      const audioBase64 = await RNFS.readFile(clipPath, 'base64')
      const audioBytes = base64ToUint8Array(audioBase64)

      audioFile = audioFileId
        ? await this.updateOrRecreateFile(audioFileId, 'clips', audioFilename, audioBytes)
        : await this.drive.uploadFile('clips', audioFilename, audioBytes)
    } catch (audioError) {
      // Rollback: if the JSON file was created (first upload or 404 fallback,
      // where its id differs from the manifest's), delete it — update-in-place
      // needs no rollback
      if (jsonFile.id !== manifest?.remote_file_id) {
        await this.drive.deleteFile(jsonFile.id).catch(() => {})
      }
      throw audioError
    }

    await this.db.upsertManifestEntry({
      entity_type: 'clip', entity_id: clip.id,
      local_updated_at: clip.updated_at,
      remote_updated_at: null,
      remote_file_id: jsonFile.id,
      remote_audio_file_id: audioFile.id,
    })

    // Stale check
    const fresh = await this.db.getClip(clip.id)
    if (fresh && fresh.updated_at > outboxItem.updated_at_when_queued) {
      await this.db.queueChange('clip', clip.id, 'upsert', fresh.updated_at)
      log(`Clip ${clip.id} was modified during upload, re-queued`)
    }

    result.uploaded.clips++
    log(`Uploaded clip: ${clip.id}`)
  }

  private async uploadSession(session: Session, outboxItem: SyncOutboxItem, result: SyncResult): Promise<void> {
    const backup: SessionBackup = {
      id: session.id,
      book_id: session.book_id,
      started_at: session.started_at,
      ended_at: session.ended_at,
      updated_at: session.updated_at,
      updated_by: session.updated_by,
    }

    const filename = `session_${session.id}.json`
    const content = JSON.stringify(backup, null, 2)

    const manifest = await this.db.getManifestEntry('session', session.id)
    const uploaded = manifest?.remote_file_id
      ? await this.updateOrRecreateFile(manifest.remote_file_id, 'sessions', filename, content)
      : await this.drive.uploadFile('sessions', filename, content)

    await this.db.upsertManifestEntry({
      entity_type: 'session', entity_id: session.id,
      local_updated_at: session.updated_at,
      remote_updated_at: null,
      remote_file_id: uploaded.id,
      remote_audio_file_id: null,
    })

    // Stale check
    const fresh = await this.db.getSessionById(session.id)
    if (fresh && fresh.updated_at > outboxItem.updated_at_when_queued) {
      await this.db.queueChange('session', session.id, 'upsert', fresh.updated_at)
      log(`Session ${session.id} was modified during upload, re-queued`)
    }

    result.uploaded.sessions++
    log(`Uploaded session: ${session.id}`)
  }

  // ---------------------------------------------------------------------------
  // Remote Deletion (Tombstones)
  // ---------------------------------------------------------------------------

  /**
   * Read the current remote JSON before tombstoning it (stale-tombstone guard).
   * The remote is also the tombstone's payload source: the local row is deleted
   * at queue time, so the last-known remote is the full payload we rewrite with
   * `deleted: true`.
   *
   * Returns null when there is nothing to tombstone and the queue item should
   * be dropped: the remote is already a tombstone, a remote edit is newer than
   * the deletion (the edit won), or the remote file is gone (404).
   */
  private async readRemoteForTombstone<T extends ClipBackup | SessionBackup>(
    remoteFileId: string,
    item: SyncOutboxItem,
  ): Promise<T | null> {
    let remote: T
    try {
      const content = await this.drive.downloadFile(remoteFileId, false) as string
      remote = JSON.parse(content)
    } catch (error: any) {
      if (error.message?.includes('404')) {
        // Remote purged (user cleanup) — nothing to tombstone
        await this.db.deleteManifestEntry(item.entity_type, item.entity_id)
        return null
      }
      throw error
    }

    if (remote.deleted) return null // already tombstoned elsewhere

    // The deletion competes under LWW as (queue time, this device)
    if (this.isRemoteAhead(item.updated_at_when_queued, this.db.deviceId, remote.updated_at, remote.updated_by)) {
      log(`Skipping stale tombstone for ${item.entity_type} ${item.entity_id}: remote edit is newer`)
      return null
    }

    return remote
  }

  private async tombstoneRemoteClip(item: SyncOutboxItem, result: SyncResult): Promise<void> {
    const manifest = await this.db.getManifestEntry('clip', item.entity_id)
    if (!manifest?.remote_file_id) {
      // Never uploaded — nothing to tombstone
      if (manifest) await this.db.deleteManifestEntry('clip', item.entity_id)
      return
    }

    const remote = await this.readRemoteForTombstone<ClipBackup>(manifest.remote_file_id, item)
    if (!remote) return

    const tombstone: ClipBackup = {
      ...remote,
      deleted: true,
      updated_at: item.updated_at_when_queued,
      updated_by: this.db.deviceId,
    }
    await this.drive.updateFile(manifest.remote_file_id, JSON.stringify(tombstone, null, 2))

    // The audio file is hard-deleted (reclaim space) — its id is dead
    if (manifest.remote_audio_file_id) {
      await this.drive.deleteFile(manifest.remote_audio_file_id).catch(() => {})
    }
    await this.db.upsertManifestEntry({
      entity_type: 'clip', entity_id: item.entity_id,
      local_updated_at: item.updated_at_when_queued, remote_updated_at: null,
      remote_file_id: manifest.remote_file_id, remote_audio_file_id: null,
    })

    result.deleted.clips++
    log(`Tombstoned remote clip: ${item.entity_id}`)
  }

  private async tombstoneRemoteSession(item: SyncOutboxItem, result: SyncResult): Promise<void> {
    const manifest = await this.db.getManifestEntry('session', item.entity_id)
    if (!manifest?.remote_file_id) {
      // Never uploaded — nothing to tombstone
      if (manifest) await this.db.deleteManifestEntry('session', item.entity_id)
      return
    }

    const remote = await this.readRemoteForTombstone<SessionBackup>(manifest.remote_file_id, item)
    if (!remote) return

    const tombstone: SessionBackup = {
      ...remote,
      deleted: true,
      updated_at: item.updated_at_when_queued,
      updated_by: this.db.deviceId,
    }
    await this.drive.updateFile(manifest.remote_file_id, JSON.stringify(tombstone, null, 2))

    await this.db.upsertManifestEntry({
      entity_type: 'session', entity_id: item.entity_id,
      local_updated_at: item.updated_at_when_queued, remote_updated_at: null,
      remote_file_id: manifest.remote_file_id, remote_audio_file_id: null,
    })

    result.deleted.sessions++
    log(`Tombstoned remote session: ${item.entity_id}`)
  }

  // ---------------------------------------------------------------------------
  // Full Reconcile (Recovery / First Sync)
  // ---------------------------------------------------------------------------

  /**
   * Full reconcile: list all remote files, compare with local, and sync.
   * Used on first sync or when the page token is invalid.
   */
  private async fullReconcile(result: SyncResult, notification: SyncNotification): Promise<void> {
    log('Starting full reconcile')

    // List all remote files
    const [bookFiles, clipFiles, sessionFiles] = await Promise.all([
      this.drive.listFiles('books'),
      this.drive.listFiles('clips'),
      this.drive.listFiles('sessions'),
    ])

    // Reconcile books
    for (const file of bookFiles) {
      const parsed = parseFilename(file.name)
      if (!parsed || parsed.type !== 'book' || parsed.extension !== 'json') continue

      try {
        const content = await this.drive.downloadFile(file.id, false) as string
        const remote: BookBackup = JSON.parse(content)
        const local = await this.db.getBookById(parsed.id)

        if (!local) {
          await this.downloadBook(remote, file.id, result, notification)
        } else if (this.isSameVersion(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) {
          // Already in sync — just record the file ID
          await this.db.upsertManifestEntry({
            entity_type: 'book', entity_id: parsed.id,
            local_updated_at: local.updated_at, remote_updated_at: null,
            remote_file_id: file.id, remote_audio_file_id: null,
          })
        } else if (this.isRemoteAhead(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) {
          await this.downloadBook(remote, file.id, result, notification)
        } else {
          // Local is ahead — record file ID and queue for push
          await this.db.upsertManifestEntry({
            entity_type: 'book', entity_id: parsed.id,
            local_updated_at: local.updated_at, remote_updated_at: null,
            remote_file_id: file.id, remote_audio_file_id: null,
          })
          await this.db.queueChange('book', parsed.id, 'upsert', local.updated_at)
        }
      } catch (error) {
        result.errors.push(`Full reconcile book ${parsed.id}: ${error}`)
      }
    }

    // Reconcile clips
    const clipsByClipId = new Map<string, { json?: DriveFile; audio?: DriveFile }>()
    for (const file of clipFiles) {
      const parsed = parseFilename(file.name)
      if (!parsed || parsed.type !== 'clip') continue
      const existing = clipsByClipId.get(parsed.id) ?? {}
      if (parsed.extension === 'json') existing.json = file
      else existing.audio = file
      clipsByClipId.set(parsed.id, existing)
    }

    for (const [clipId, { json, audio }] of clipsByClipId) {
      if (!json) continue

      try {
        const content = await this.drive.downloadFile(json.id, false) as string
        const remote: ClipBackup = JSON.parse(content)

        // Tombstones have no audio file — branch on deleted before requiring one
        if (remote.deleted) {
          await this.applyClipTombstone(remote, json.id, result, notification)
          continue
        }

        if (!audio) continue // live clips need their audio file

        const local = await this.db.getClip(clipId)

        if (!local) {
          await this.downloadClip(remote, json.id, audio.id, audio.name, result, notification)
        } else if (this.isSameVersion(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) {
          await this.db.upsertManifestEntry({
            entity_type: 'clip', entity_id: clipId,
            local_updated_at: local.updated_at, remote_updated_at: null,
            remote_file_id: json.id, remote_audio_file_id: audio.id,
          })
        } else if (this.isRemoteAhead(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) {
          await this.downloadClip(remote, json.id, audio.id, audio.name, result, notification)
        } else {
          await this.db.upsertManifestEntry({
            entity_type: 'clip', entity_id: clipId,
            local_updated_at: local.updated_at, remote_updated_at: null,
            remote_file_id: json.id, remote_audio_file_id: audio.id,
          })
          await this.db.queueChange('clip', clipId, 'upsert', local.updated_at)
        }
      } catch (error) {
        result.errors.push(`Full reconcile clip ${clipId}: ${error}`)
      }
    }

    // Reconcile sessions
    for (const file of sessionFiles) {
      const parsed = parseFilename(file.name)
      if (!parsed || parsed.type !== 'session' || parsed.extension !== 'json') continue

      try {
        const content = await this.drive.downloadFile(file.id, false) as string
        const remote: SessionBackup = JSON.parse(content)

        if (remote.deleted) {
          await this.applySessionTombstone(remote, file.id, result, notification)
          continue
        }

        const local = await this.db.getSessionById(parsed.id)

        if (!local) {
          await this.downloadSession(remote, file.id, result, notification)
        } else if (this.isSameVersion(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) {
          await this.db.upsertManifestEntry({
            entity_type: 'session', entity_id: parsed.id,
            local_updated_at: local.updated_at, remote_updated_at: null,
            remote_file_id: file.id, remote_audio_file_id: null,
          })
        } else if (this.isRemoteAhead(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)) {
          await this.downloadSession(remote, file.id, result, notification)
        } else {
          await this.db.upsertManifestEntry({
            entity_type: 'session', entity_id: parsed.id,
            local_updated_at: local.updated_at, remote_updated_at: null,
            remote_file_id: file.id, remote_audio_file_id: null,
          })
          await this.db.queueChange('session', parsed.id, 'upsert', local.updated_at)
        }
      } catch (error) {
        result.errors.push(`Full reconcile session ${parsed.id}: ${error}`)
      }
    }

    // Also queue local-only entities (those with no remote file)
    await this.queueLocalOnlyEntities(bookFiles, clipFiles, sessionFiles)

    await this.db.setCheckpointFullReconcile(Date.now())
    log('Full reconcile complete')
  }

  /**
   * Queue local entities that have no remote counterpart for upload.
   */
  private async queueLocalOnlyEntities(
    remoteBookFiles: DriveFile[],
    remoteClipFiles: DriveFile[],
    remoteSessionFiles: DriveFile[],
  ): Promise<void> {
    const remoteBookIds = new Set<string>()
    const remoteClipIds = new Set<string>()
    const remoteSessionIds = new Set<string>()

    for (const f of remoteBookFiles) {
      const p = parseFilename(f.name)
      if (p?.type === 'book') remoteBookIds.add(p.id)
    }
    for (const f of remoteClipFiles) {
      const p = parseFilename(f.name)
      if (p?.type === 'clip') remoteClipIds.add(p.id)
    }
    for (const f of remoteSessionFiles) {
      const p = parseFilename(f.name)
      if (p?.type === 'session') remoteSessionIds.add(p.id)
    }

    const localBooks = await this.db.getAllBooks()
    for (const book of localBooks) {
      if (!remoteBookIds.has(book.id)) {
        await this.db.queueChange('book', book.id, 'upsert', book.updated_at)
      }
    }

    // getAllClipIds doesn't return updated_at, so we fall back to Date.now().
    // This is acceptable: local-only clips are new and their updated_at ≈ now.
    const localClipIds = await this.db.getAllClipIds()
    for (const clipId of localClipIds) {
      if (!remoteClipIds.has(clipId)) {
        await this.db.queueChange('clip', clipId, 'upsert')
      }
    }

    const localSessions = await this.db.getAllSessionsRaw()
    for (const session of localSessions) {
      if (!remoteSessionIds.has(session.id)) {
        await this.db.queueChange('session', session.id, 'upsert', session.updated_at)
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
    type: match[1] as 'book' | 'clip' | 'session',
    id: match[2],
    extension: match[3] as 'json' | 'mp3' | 'm4a',
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
