import { BackupSyncService } from '../sync'
import type { DatabaseService, Book, Clip, Session } from '../../storage'
import type { GoogleDriveService } from '../drive'
import type { GoogleAuthService } from '../auth'

// Helper: encode Uint8Array to base64 (mirrors sync.ts internal helper)
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

const FINGERPRINT = new Uint8Array([1, 2, 3, 4])
const FINGERPRINT_B64 = uint8ArrayToBase64(FINGERPRINT)

// IDs must be hex + hyphens to match the filename regex
const BOOK_ID = 'aaa00001-0000-0000-0000-000000000001'
const CLIP_ID = 'ccc00001-0000-0000-0000-000000000001'

function createBook(overrides: Partial<Book> = {}): Book {
  return {
    id: BOOK_ID,
    uri: `file:///audio/${BOOK_ID}.mp3`,
    name: 'Test Book',
    duration: 60000,
    position: 5000,
    updated_at: 1000,
    updated_by: 'device-a',
    title: 'Test Title',
    artist: 'Test Artist',
    artwork: null,
    file_size: 100000,
    fingerprint: FINGERPRINT,
    hidden: false,
    chapters: null,
    speed: 100,
    ...overrides,
  }
}

function createRemoteBookJson(overrides: Record<string, any> = {}): string {
  return JSON.stringify({
    id: BOOK_ID,
    name: 'Test Book',
    duration: 60000,
    position: 5000,
    updated_at: 2000,
    updated_by: 'device-b',
    title: 'Remote Title',
    artist: 'Remote Artist',
    artwork: null,
    file_size: 100000,
    fingerprint: FINGERPRINT_B64,
    hidden: false,
    speed: 100,
    ...overrides,
  })
}

describe('BackupSyncService', () => {
  function createMockDeps() {
    const db: jest.Mocked<DatabaseService> = {
      getAllBooks: jest.fn(async () => []),
      getAllClips: jest.fn(async () => []),
      getAllClipIds: jest.fn(async () => []),
      getAllSessionsRaw: jest.fn(async () => []),
      getAllManifestEntries: jest.fn(async () => []),
      getManifestEntry: jest.fn(async () => null),
      getLastSyncTime: jest.fn(() => null),
      setLastSyncTime: jest.fn(async () => {}),
      upsertManifestEntry: jest.fn(async () => {}),
      deleteManifestEntry: jest.fn(async () => {}),
      getBookById: jest.fn(async () => null),
      getBookByFingerprint: jest.fn(async () => null),
      getClip: jest.fn(async () => null),
      getSessionById: jest.fn(async () => null),
      restoreBookFromBackup: jest.fn(async () => {}),
      restoreClipFromBackup: jest.fn(async () => {}),
      restoreSessionFromBackup: jest.fn(async () => {}),
      getCheckpoint: jest.fn(() => ({ last_page_token: null, last_full_reconcile_at: null })),
      setCheckpointPageToken: jest.fn(async () => {}),
      setCheckpointFullReconcile: jest.fn(async () => {}),
      clearCheckpoint: jest.fn(async () => {}),
      getOutboxItems: jest.fn(async () => []),
      removeOutboxItem: jest.fn(async () => {}),
      updateOutboxItemAttempt: jest.fn(async () => {}),
      queueChange: jest.fn(async () => {}),
      getQueueCount: jest.fn(async () => 0),
      deviceId: 'test-device',
    } as any

    const drive: jest.Mocked<GoogleDriveService> = {
      listFiles: jest.fn(async () => []),
      uploadFile: jest.fn(async () => ({ id: 'new-file-id', name: 'test', mimeType: 'application/json' })),
      updateFile: jest.fn(async () => ({ id: 'existing-file-id', name: 'test', mimeType: 'application/json' })),
      downloadFile: jest.fn(async () => '{}'),
      deleteFile: jest.fn(async () => {}),
      getStartPageToken: jest.fn(async () => '12345'),
      getChanges: jest.fn(async () => ({ changes: [], newStartPageToken: '12346' })),
    } as any

    const auth: jest.Mocked<GoogleAuthService> = {
      initialize: jest.fn(async () => {}),
      isAuthenticated: jest.fn(() => true),
      getAccessToken: jest.fn(async () => 'mock-token'),
      signIn: jest.fn(async () => true),
    } as any

    return { db, drive, auth }
  }

  // ===========================================================================
  // Concurrency & Auth
  // ===========================================================================

  describe('syncNow', () => {
    it('prevents concurrent sync operations', async () => {
      const { db, drive, auth } = createMockDeps()

      let performSyncStarted = 0
      db.setLastSyncTime.mockImplementation(async () => { performSyncStarted++ })

      drive.listFiles.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return []
      })

      const service = new BackupSyncService(db, drive, auth)
      const p1 = service.syncNow()
      const p2 = service.syncNow()
      const p3 = service.syncNow()
      await Promise.all([p1, p2, p3])

      expect(performSyncStarted).toBe(1)
    })

    it('allows subsequent sync after first completes', async () => {
      const { db, drive, auth } = createMockDeps()

      let count = 0
      db.setLastSyncTime.mockImplementation(async () => { count++ })

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()
      await service.syncNow()

      expect(count).toBe(2)
    })

    it('resets sync flag on error', async () => {
      const { db, drive, auth } = createMockDeps()

      let authInitCount = 0
      auth.initialize.mockImplementation(async () => {
        authInitCount++
        if (authInitCount === 1) throw new Error('Network error')
      })

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()
      await service.syncNow()

      expect(authInitCount).toBe(2)
    })
  })

  describe('autoSync', () => {
    it('skips sync when not authenticated', async () => {
      const { db, drive, auth } = createMockDeps()
      auth.getAccessToken.mockResolvedValue(null)

      let count = 0
      db.setLastSyncTime.mockImplementation(async () => { count++ })

      const service = new BackupSyncService(db, drive, auth)
      await service.autoSync()

      expect(count).toBe(0)
    })
  })

  // ===========================================================================
  // Incremental Pull (Change Feed Reconciliation)
  // ===========================================================================

  describe('incremental pull', () => {
    it('downloads a book when remote is ahead', async () => {
      const { db, drive, auth } = createMockDeps()

      // Existing page token → incremental path
      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })

      // Change feed returns one changed book
      const remoteJson = createRemoteBookJson({ updated_at: 2000, updated_by: 'device-b' })
      drive.getChanges.mockResolvedValue({
        changes: [{
          fileId: 'drive-book-1',
          removed: false,
          file: { id: 'drive-book-1', name: `book_${BOOK_ID}.json`, mimeType: 'application/json' },
        }],
        newStartPageToken: '101',
      })
      drive.downloadFile.mockResolvedValue(remoteJson)

      // Local book is older
      db.getBookById.mockResolvedValue(createBook({ updated_at: 1000, updated_by: 'device-a' }))
      db.getBookByFingerprint.mockResolvedValue(null)

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      expect(db.restoreBookFromBackup).toHaveBeenCalled()
      expect(db.restoreBookFromBackup.mock.calls[0][0]).toBe(BOOK_ID)
      expect(db.setCheckpointPageToken).toHaveBeenCalledWith('101')
    })

    it('queues for push when local is ahead', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })

      const remoteJson = createRemoteBookJson({ updated_at: 1000, updated_by: 'device-b' })
      drive.getChanges.mockResolvedValue({
        changes: [{
          fileId: 'drive-book-1',
          removed: false,
          file: { id: 'drive-book-1', name: `book_${BOOK_ID}.json`, mimeType: 'application/json' },
        }],
        newStartPageToken: '101',
      })
      drive.downloadFile.mockResolvedValue(remoteJson)

      // Local book is newer
      db.getBookById.mockResolvedValue(createBook({ updated_at: 3000, updated_by: 'device-a' }))

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      expect(db.restoreBookFromBackup).not.toHaveBeenCalled()
      expect(db.queueChange).toHaveBeenCalledWith('book', BOOK_ID, 'upsert', 3000)
    })

    it('uses tie-breaker when timestamps match but devices differ', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })

      // Same updated_at, different updated_by → tie-breaker picks a winner (not a merge)
      const remoteJson = createRemoteBookJson({
        updated_at: 1000,
        updated_by: 'device-b',
        position: 9000,
      })
      drive.getChanges.mockResolvedValue({
        changes: [{
          fileId: 'drive-book-1',
          removed: false,
          file: { id: 'drive-book-1', name: `book_${BOOK_ID}.json`, mimeType: 'application/json' },
        }],
        newStartPageToken: '101',
      })
      drive.downloadFile.mockResolvedValue(remoteJson)

      db.getBookById.mockResolvedValue(createBook({
        updated_at: 1000,
        updated_by: 'device-a',
        position: 5000,
      }))
      db.getBookByFingerprint.mockResolvedValue(null)

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      // 'device-b' > 'device-a' → remote is ahead → download, not merge
      expect(db.restoreBookFromBackup).toHaveBeenCalled()
    })

    it('skips when same version (same timestamp, same device)', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })

      const remoteJson = createRemoteBookJson({
        updated_at: 1000,
        updated_by: 'device-a',
      })
      drive.getChanges.mockResolvedValue({
        changes: [{
          fileId: 'drive-book-1',
          removed: false,
          file: { id: 'drive-book-1', name: `book_${BOOK_ID}.json`, mimeType: 'application/json' },
        }],
        newStartPageToken: '101',
      })
      drive.downloadFile.mockResolvedValue(remoteJson)

      db.getBookById.mockResolvedValue(createBook({
        updated_at: 1000,
        updated_by: 'device-a',
      }))

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      // Should not download, merge, or queue
      expect(db.restoreBookFromBackup).not.toHaveBeenCalled()
      expect(db.queueChange).not.toHaveBeenCalled()
      // Should still update manifest with file ID
      expect(db.upsertManifestEntry).toHaveBeenCalled()
    })

    it('downloads new book when no local entity exists', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })

      const remoteJson = createRemoteBookJson({ id: 'bbb00002-0000-0000-0000-000000000002' })
      drive.getChanges.mockResolvedValue({
        changes: [{
          fileId: 'drive-new',
          removed: false,
          file: { id: 'drive-new', name: 'book_bbb00002-0000-0000-0000-000000000002.json', mimeType: 'application/json' },
        }],
        newStartPageToken: '101',
      })
      drive.downloadFile.mockResolvedValue(remoteJson)

      db.getBookById.mockResolvedValue(null)
      db.getBookByFingerprint.mockResolvedValue(null)

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      expect(db.restoreBookFromBackup).toHaveBeenCalled()
      expect(db.restoreBookFromBackup.mock.calls[0][0]).toBe('bbb00002-0000-0000-0000-000000000002')
    })

    it('skips removed files', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })

      drive.getChanges.mockResolvedValue({
        changes: [{
          fileId: 'drive-removed',
          removed: true,
        }],
        newStartPageToken: '101',
      })

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      expect(drive.downloadFile).not.toHaveBeenCalled()
      expect(db.restoreBookFromBackup).not.toHaveBeenCalled()
    })

    it('does not advance the page token when a reconcile fails', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })

      drive.getChanges.mockResolvedValue({
        changes: [{
          fileId: 'drive-book-1',
          removed: false,
          file: { id: 'drive-book-1', name: `book_${BOOK_ID}.json`, mimeType: 'application/json' },
        }],
        newStartPageToken: '101',
      })
      // Reconcile fails: remote JSON can't be downloaded
      drive.downloadFile.mockRejectedValue(new Error('Network error'))

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      // Token must not advance — the failed change is re-delivered next sync
      expect(db.setCheckpointPageToken).not.toHaveBeenCalled()
    })

    it('falls back to full reconcile on invalid page token', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: 'stale-token', last_full_reconcile_at: null })

      // First call fails with 410
      drive.getChanges.mockRejectedValueOnce(new Error('410 Gone'))
      // After clearCheckpoint, getCheckpoint returns null → full reconcile
      db.clearCheckpoint.mockImplementation(async () => {
        db.getCheckpoint.mockReturnValue({ last_page_token: null, last_full_reconcile_at: null })
      })

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      expect(db.clearCheckpoint).toHaveBeenCalled()
      // Full reconcile path: getStartPageToken is called
      expect(drive.getStartPageToken).toHaveBeenCalled()
    })
  })

  // ===========================================================================
  // Push Phase (Outbox Drain)
  // ===========================================================================

  describe('push phase', () => {
    it('uploads a book from the outbox', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })
      drive.getChanges.mockResolvedValue({ changes: [], newStartPageToken: '101' })

      const book = createBook()
      db.getOutboxItems.mockResolvedValue([{
        id: 'outbox-1',
        entity_type: 'book' as const,
        entity_id: BOOK_ID,
        operation: 'upsert' as const,
        updated_at_when_queued: 1000,
        queued_at: 1000,
        attempts: 0,
        last_error: null,
        next_attempt_at: 0,
      }])
      db.getBookById.mockResolvedValue(book)

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      expect(drive.uploadFile).toHaveBeenCalled()
      expect(db.removeOutboxItem).toHaveBeenCalledWith('book', BOOK_ID, 1000)
    })

    it('uses updateFile when manifest has remote_file_id', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })
      drive.getChanges.mockResolvedValue({ changes: [], newStartPageToken: '101' })

      const book = createBook()
      db.getOutboxItems.mockResolvedValue([{
        id: 'outbox-1',
        entity_type: 'book' as const,
        entity_id: BOOK_ID,
        operation: 'upsert' as const,
        updated_at_when_queued: 1000,
        queued_at: 1000,
        attempts: 0,
        last_error: null,
        next_attempt_at: 0,
      }])
      db.getBookById.mockResolvedValue(book)
      db.getManifestEntry.mockResolvedValue({
        entity_type: 'book',
        entity_id: BOOK_ID,
        local_updated_at: 500,
        remote_updated_at: null,
        remote_file_id: 'existing-drive-id',
        remote_audio_file_id: null,
        synced_at: 500,
      })

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      expect(drive.updateFile).toHaveBeenCalledWith('existing-drive-id', expect.any(String))
      expect(drive.uploadFile).not.toHaveBeenCalled()
    })

    it('uses uploadFile when no manifest exists (first upload)', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })
      drive.getChanges.mockResolvedValue({ changes: [], newStartPageToken: '101' })

      const book = createBook()
      db.getOutboxItems.mockResolvedValue([{
        id: 'outbox-1',
        entity_type: 'book' as const,
        entity_id: BOOK_ID,
        operation: 'upsert' as const,
        updated_at_when_queued: 1000,
        queued_at: 1000,
        attempts: 0,
        last_error: null,
        next_attempt_at: 0,
      }])
      db.getBookById.mockResolvedValue(book)
      db.getManifestEntry.mockResolvedValue(null)

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      expect(drive.uploadFile).toHaveBeenCalled()
      expect(drive.updateFile).not.toHaveBeenCalled()
    })

    it('re-queues when entity was modified during upload (stale detection)', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })
      drive.getChanges.mockResolvedValue({ changes: [], newStartPageToken: '101' })

      const book = createBook({ updated_at: 1000 })
      db.getOutboxItems.mockResolvedValue([{
        id: 'outbox-1',
        entity_type: 'book' as const,
        entity_id: BOOK_ID,
        operation: 'upsert' as const,
        updated_at_when_queued: 1000,
        queued_at: 1000,
        attempts: 0,
        last_error: null,
        next_attempt_at: 0,
      }])

      // First getBookById call (for upload): returns original
      // Second getBookById call (stale check): returns modified version
      db.getBookById
        .mockResolvedValueOnce(book)
        .mockResolvedValueOnce(createBook({ updated_at: 2000 }))

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      // The upload re-queues with the fresh entity's updated_at, and the
      // outbox removal is conditional on the ORIGINAL updated_at_when_queued
      // so the re-queued row survives
      expect(db.queueChange).toHaveBeenCalledWith('book', BOOK_ID, 'upsert', 2000)
      expect(db.removeOutboxItem).toHaveBeenCalledWith('book', BOOK_ID, 1000)
    })

    it('keeps a re-queued outbox row when clearing the pushed item', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })
      drive.getChanges.mockResolvedValue({ changes: [], newStartPageToken: '101' })

      // Emulate the real sync_queue table: UNIQUE(entity_type, entity_id) with
      // upsert semantics on queueChange, conditional delete on removeOutboxItem
      const table = new Map<string, { operation: string; updated_at_when_queued: number }>()
      table.set(`book:${BOOK_ID}`, { operation: 'upsert', updated_at_when_queued: 1000 })

      db.queueChange.mockImplementation(async (type, id, operation, entityUpdatedAt) => {
        table.set(`${type}:${id}`, { operation, updated_at_when_queued: entityUpdatedAt ?? Date.now() })
      })
      db.removeOutboxItem.mockImplementation(async (type, id, queuedUpdatedAt) => {
        const row = table.get(`${type}:${id}`)
        if (row && row.updated_at_when_queued === queuedUpdatedAt) {
          table.delete(`${type}:${id}`)
        }
      })

      db.getOutboxItems.mockResolvedValue([{
        id: 'outbox-1',
        entity_type: 'book' as const,
        entity_id: BOOK_ID,
        operation: 'upsert' as const,
        updated_at_when_queued: 1000,
        queued_at: 1000,
        attempts: 0,
        last_error: null,
        next_attempt_at: 0,
      }])

      // Entity is modified during upload: the stale check re-queues it
      db.getBookById
        .mockResolvedValueOnce(createBook({ updated_at: 1000 }))
        .mockResolvedValueOnce(createBook({ updated_at: 2000 }))

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      // The re-queued row (updated_at_when_queued = 2000) must survive removal
      expect(table.get(`book:${BOOK_ID}`)).toEqual({ operation: 'upsert', updated_at_when_queued: 2000 })
    })

    it('does not re-queue when entity has not changed since enqueue', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })
      drive.getChanges.mockResolvedValue({ changes: [], newStartPageToken: '101' })

      const book = createBook({ updated_at: 1000 })
      db.getOutboxItems.mockResolvedValue([{
        id: 'outbox-1',
        entity_type: 'book' as const,
        entity_id: BOOK_ID,
        operation: 'upsert' as const,
        updated_at_when_queued: 1000,
        queued_at: 1000,
        attempts: 0,
        last_error: null,
        next_attempt_at: 0,
      }])

      // Both calls return same updated_at
      db.getBookById.mockResolvedValue(book)

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      // queueChange should NOT have been called (no stale re-queue)
      expect(db.queueChange).not.toHaveBeenCalled()
    })

    it('increments attempts on upload failure', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })
      drive.getChanges.mockResolvedValue({ changes: [], newStartPageToken: '101' })

      db.getOutboxItems.mockResolvedValue([{
        id: 'outbox-1',
        entity_type: 'book' as const,
        entity_id: BOOK_ID,
        operation: 'upsert' as const,
        updated_at_when_queued: 1000,
        queued_at: 1000,
        attempts: 0,
        last_error: null,
        next_attempt_at: 0,
      }])

      db.getBookById.mockResolvedValue(createBook())
      drive.uploadFile.mockRejectedValue(new Error('Network error'))

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      expect(db.updateOutboxItemAttempt).toHaveBeenCalledWith('book', BOOK_ID, 'Network error')
      expect(db.removeOutboxItem).not.toHaveBeenCalled()
    })

    it('tombstones remote clip on delete operation', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })
      drive.getChanges.mockResolvedValue({ changes: [], newStartPageToken: '101' })

      db.getOutboxItems.mockResolvedValue([{
        id: 'outbox-1',
        entity_type: 'clip' as const,
        entity_id: CLIP_ID,
        operation: 'delete' as const,
        updated_at_when_queued: 1000,
        queued_at: 1000,
        attempts: 0,
        last_error: null,
        next_attempt_at: 0,
      }])

      db.getManifestEntry.mockResolvedValue({
        entity_type: 'clip',
        entity_id: CLIP_ID,
        local_updated_at: null,
        remote_updated_at: null,
        remote_file_id: 'json-file-id',
        remote_audio_file_id: 'audio-file-id',
        synced_at: 1000,
      })

      // Stale-tombstone guard reads the current remote payload first
      drive.downloadFile.mockResolvedValue(JSON.stringify({
        id: CLIP_ID, source_id: BOOK_ID, start: 1000, duration: 5000,
        note: 'A note', transcription: null, created_at: 500,
        updated_at: 500, updated_by: 'device-a',
      }))

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      // JSON is rewritten in place as a full-payload tombstone
      expect(drive.updateFile).toHaveBeenCalledWith('json-file-id', expect.stringContaining('"deleted": true'))
      const tombstone = JSON.parse(drive.updateFile.mock.calls[0][1] as string)
      expect(tombstone.note).toBe('A note') // full payload preserved
      expect(tombstone.updated_at).toBe(1000) // deletion time wins LWW

      // Only the audio file is hard-deleted; the manifest row survives with a dead audio id nulled
      expect(drive.deleteFile).toHaveBeenCalledWith('audio-file-id')
      expect(drive.deleteFile).not.toHaveBeenCalledWith('json-file-id')
      expect(db.deleteManifestEntry).not.toHaveBeenCalled()
      expect(db.upsertManifestEntry).toHaveBeenCalledWith(expect.objectContaining({
        entity_type: 'clip', entity_id: CLIP_ID,
        remote_file_id: 'json-file-id', remote_audio_file_id: null,
      }))
      expect(db.removeOutboxItem).toHaveBeenCalledWith('clip', CLIP_ID, 1000)
    })

    it('drops a queued delete when the remote was edited after the deletion', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })
      drive.getChanges.mockResolvedValue({ changes: [], newStartPageToken: '101' })

      db.getOutboxItems.mockResolvedValue([{
        id: 'outbox-1',
        entity_type: 'clip' as const,
        entity_id: CLIP_ID,
        operation: 'delete' as const,
        updated_at_when_queued: 1000,
        queued_at: 1000,
        attempts: 0,
        last_error: null,
        next_attempt_at: 0,
      }])

      db.getManifestEntry.mockResolvedValue({
        entity_type: 'clip',
        entity_id: CLIP_ID,
        local_updated_at: null,
        remote_updated_at: null,
        remote_file_id: 'json-file-id',
        remote_audio_file_id: 'audio-file-id',
        synced_at: 1000,
      })

      // Remote edit is newer than the queued deletion — the edit won
      drive.downloadFile.mockResolvedValue(JSON.stringify({
        id: CLIP_ID, source_id: BOOK_ID, start: 1000, duration: 5000,
        note: 'Edited elsewhere', transcription: null, created_at: 500,
        updated_at: 2000, updated_by: 'device-b',
      }))

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      expect(drive.updateFile).not.toHaveBeenCalled()
      expect(drive.deleteFile).not.toHaveBeenCalled()
      expect(db.deleteManifestEntry).not.toHaveBeenCalled()
      expect(db.removeOutboxItem).toHaveBeenCalledWith('clip', CLIP_ID, 1000)
    })

    it('drops a queued delete and the manifest when the remote file is gone', async () => {
      const { db, drive, auth } = createMockDeps()

      db.getCheckpoint.mockReturnValue({ last_page_token: '100', last_full_reconcile_at: null })
      drive.getChanges.mockResolvedValue({ changes: [], newStartPageToken: '101' })

      db.getOutboxItems.mockResolvedValue([{
        id: 'outbox-1',
        entity_type: 'clip' as const,
        entity_id: CLIP_ID,
        operation: 'delete' as const,
        updated_at_when_queued: 1000,
        queued_at: 1000,
        attempts: 0,
        last_error: null,
        next_attempt_at: 0,
      }])

      db.getManifestEntry.mockResolvedValue({
        entity_type: 'clip',
        entity_id: CLIP_ID,
        local_updated_at: null,
        remote_updated_at: null,
        remote_file_id: 'json-file-id',
        remote_audio_file_id: 'audio-file-id',
        synced_at: 1000,
      })

      // User purged Drive — nothing to tombstone
      drive.downloadFile.mockRejectedValue(new Error('Failed to download file: 404'))

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      expect(drive.updateFile).not.toHaveBeenCalled()
      expect(db.deleteManifestEntry).toHaveBeenCalledWith('clip', CLIP_ID)
      expect(db.removeOutboxItem).toHaveBeenCalledWith('clip', CLIP_ID, 1000)
    })
  })

  // ===========================================================================
  // Fingerprint Deduplication
  // ===========================================================================

  describe('fingerprint deduplication', () => {
    function setupFullReconcileWithRemoteBook(deps: ReturnType<typeof createMockDeps>, remoteId: string) {
      const { drive } = deps
      const remoteBookJson = createRemoteBookJson({ id: remoteId })

      drive.listFiles.mockImplementation(async (folder: string) => {
        if (folder === 'books') {
          return [{ id: 'drive-file-1', name: `book_${remoteId}.json`, mimeType: 'application/json', modifiedTime: new Date(2000).toISOString() }]
        }
        return []
      })
      drive.downloadFile.mockResolvedValue(remoteBookJson)
    }

    it('skips download when remote book fingerprint matches a local book with different ID', async () => {
      const deps = createMockDeps()
      const { db } = deps
      const localBook = createBook({ id: 'a0a00000-0000-0000-0000-00000000a0a0' })

      db.getAllBooks.mockResolvedValue([localBook])
      db.getBookByFingerprint.mockResolvedValue(localBook)

      setupFullReconcileWithRemoteBook(deps, 'b0b00000-0000-0000-0000-00000000b0b0')

      const service = new BackupSyncService(db, deps.drive, deps.auth)
      await service.syncNow()

      expect(db.restoreBookFromBackup).not.toHaveBeenCalled()
    })

    it('allows download when no fingerprint match exists', async () => {
      const deps = createMockDeps()
      const { db } = deps

      db.getBookByFingerprint.mockResolvedValue(null)

      setupFullReconcileWithRemoteBook(deps, 'b0b00000-0000-0000-0000-00000000b0b0')

      const service = new BackupSyncService(db, deps.drive, deps.auth)
      await service.syncNow()

      expect(db.restoreBookFromBackup).toHaveBeenCalled()
      expect(db.restoreBookFromBackup.mock.calls[0][0]).toBe('b0b00000-0000-0000-0000-00000000b0b0')
    })

    it('allows download when fingerprint matches the same ID (not a duplicate)', async () => {
      const deps = createMockDeps()
      const { db } = deps
      const localBook = createBook({ id: 'aabbccdd-0000-0000-0000-0000aabbccdd' })

      db.getAllBooks.mockResolvedValue([localBook])
      db.getBookByFingerprint.mockResolvedValue(localBook)

      setupFullReconcileWithRemoteBook(deps, 'aabbccdd-0000-0000-0000-0000aabbccdd')

      const service = new BackupSyncService(db, deps.drive, deps.auth)
      await service.syncNow()

      expect(db.restoreBookFromBackup).toHaveBeenCalled()
    })
  })

  // ===========================================================================
  // Full Reconcile
  // ===========================================================================

  describe('full reconcile', () => {
    it('queues local-only books for upload', async () => {
      const { db, drive, auth } = createMockDeps()

      // No page token → full reconcile
      db.getAllBooks.mockResolvedValue([createBook({ id: 'eee00001-0000-0000-0000-000000000001' })])

      // No remote books
      drive.listFiles.mockResolvedValue([])

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      expect(db.queueChange).toHaveBeenCalledWith('book', 'eee00001-0000-0000-0000-000000000001', 'upsert', 1000)
    })

    it('saves page token after full reconcile', async () => {
      const { db, drive, auth } = createMockDeps()

      drive.getStartPageToken.mockResolvedValue('fresh-token')

      const service = new BackupSyncService(db, drive, auth)
      await service.syncNow()

      expect(db.setCheckpointPageToken).toHaveBeenCalledWith('fresh-token')
    })
  })
})
