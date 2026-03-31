import { BackupSyncService } from '../sync'
import type { DatabaseService, Book } from '../../storage'
import type { GoogleDriveService } from '../drive'
import type { GoogleAuthService } from '../auth'

/**
 * Tests for the BackupSyncService.
 *
 * Bug #2: Race condition where multiple syncNow() calls could
 * run concurrently before the isSyncing flag was set.
 */

// Helper: encode Uint8Array to base64 (mirrors sync.ts internal helper)
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

describe('BackupSyncService', () => {
  // Mock dependencies
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
      listFiles: jest.fn(() => Promise.resolve([])),
      uploadFile: jest.fn(),
      updateFile: jest.fn(),
      downloadFile: jest.fn(),
      deleteFile: jest.fn(),
      getStartPageToken: jest.fn(async () => '12345'),
      getChanges: jest.fn(async () => ({ changes: [], newStartPageToken: '12346' })),
    } as any

    const auth: jest.Mocked<GoogleAuthService> = {
      initialize: jest.fn(() => Promise.resolve()),
      isAuthenticated: jest.fn(() => true),
      getAccessToken: jest.fn(() => Promise.resolve('mock-token')),
      signIn: jest.fn(() => Promise.resolve(true)),
    } as any

    return { db, drive, auth }
  }

  describe('syncNow', () => {
    it('prevents concurrent sync operations', async () => {
      const { db, drive, auth } = createMockDeps()

      let performSyncStarted = 0

      db.setLastSyncTime.mockImplementation(async () => {
        performSyncStarted++
      })

      // Make sync take some time (full reconcile lists files)
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

      let syncCompletedCount = 0
      db.setLastSyncTime.mockImplementation(async () => {
        syncCompletedCount++
      })

      const service = new BackupSyncService(db, drive, auth)

      await service.syncNow()
      expect(syncCompletedCount).toBe(1)

      await service.syncNow()
      expect(syncCompletedCount).toBe(2)
    })

    it('resets sync flag on error', async () => {
      const { db, drive, auth } = createMockDeps()

      let authInitCount = 0
      auth.initialize.mockImplementation(async () => {
        authInitCount++
        if (authInitCount === 1) {
          throw new Error('Network error')
        }
      })

      const service = new BackupSyncService(db, drive, auth)

      await service.syncNow()
      expect(authInitCount).toBe(1)

      await service.syncNow()
      expect(authInitCount).toBe(2)
    })
  })

  describe('autoSync', () => {
    it('prevents concurrent auto-sync operations', async () => {
      const { db, drive, auth } = createMockDeps()

      let syncCompletedCount = 0
      db.setLastSyncTime.mockImplementation(async () => {
        syncCompletedCount++
      })

      drive.listFiles.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return []
      })

      const service = new BackupSyncService(db, drive, auth)

      const p1 = service.autoSync()
      const p2 = service.autoSync()
      const p3 = service.autoSync()

      await Promise.all([p1, p2, p3])

      expect(syncCompletedCount).toBe(1)
    })

    it('skips sync when not authenticated', async () => {
      const { db, drive, auth } = createMockDeps()

      auth.getAccessToken.mockResolvedValue(null)

      let syncCompletedCount = 0
      db.setLastSyncTime.mockImplementation(async () => {
        syncCompletedCount++
      })

      const service = new BackupSyncService(db, drive, auth)

      await service.autoSync()

      expect(syncCompletedCount).toBe(0)
    })
  })

  describe('fingerprint deduplication', () => {
    const FINGERPRINT = new Uint8Array([1, 2, 3, 4])
    const FINGERPRINT_B64 = uint8ArrayToBase64(FINGERPRINT)
    const FILE_SIZE = 1000000

    function createLocalBook(id: string): Book {
      return {
        id,
        uri: `file:///path/to/${id}.mp3`,
        name: `Book ${id}`,
        duration: 60000,
        position: 5000,
        updated_at: 1000,
        updated_by: 'device-a',
        title: 'My Book',
        artist: 'Author',
        artwork: null,
        file_size: FILE_SIZE,
        fingerprint: FINGERPRINT,
        hidden: false,
        chapters: null,
        speed: 100,
      }
    }

    function setupFullReconcileWithRemoteBook(deps: ReturnType<typeof createMockDeps>, remoteId: string) {
      const { drive } = deps
      const remoteBookJson = JSON.stringify({
        id: remoteId,
        name: 'Book remote',
        duration: 60000,
        position: 3000,
        updated_at: 2000,
        updated_by: 'device-b',
        title: 'My Book',
        artist: 'Author',
        artwork: null,
        file_size: FILE_SIZE,
        fingerprint: FINGERPRINT_B64,
        hidden: false,
      })

      // Drive returns one remote book JSON file (used during full reconcile)
      drive.listFiles.mockImplementation(async (folder: string) => {
        if (folder === 'books') {
          return [{ id: 'drive-file-1', name: `book_${remoteId}.json`, mimeType: 'application/json', modifiedTime: new Date(2000).toISOString() }]
        }
        return []
      })
      drive.downloadFile.mockResolvedValue(remoteBookJson)

      return { remoteBookJson }
    }

    it('skips download when remote book fingerprint matches a local book with different ID', async () => {
      const deps = createMockDeps()
      const { db } = deps
      const localBook = createLocalBook('a0a0-a0a0')

      db.getAllBooks.mockResolvedValue([localBook])
      db.getBookByFingerprint.mockResolvedValue(localBook)

      setupFullReconcileWithRemoteBook(deps, 'b0b0-b0b0')

      const service = new BackupSyncService(db, deps.drive, deps.auth)
      await service.syncNow()

      expect(db.restoreBookFromBackup).not.toHaveBeenCalled()
    })

    it('allows download when no fingerprint match exists', async () => {
      const deps = createMockDeps()
      const { db } = deps

      db.getBookByFingerprint.mockResolvedValue(null)

      setupFullReconcileWithRemoteBook(deps, 'b0b0-b0b0')

      const service = new BackupSyncService(db, deps.drive, deps.auth)
      await service.syncNow()

      expect(db.restoreBookFromBackup).toHaveBeenCalled()
      expect(db.restoreBookFromBackup.mock.calls[0][0]).toBe('b0b0-b0b0')
    })

    it('allows download when fingerprint matches the same ID (not a duplicate)', async () => {
      const deps = createMockDeps()
      const { db } = deps
      const localBook = createLocalBook('aabb-ccdd')

      db.getAllBooks.mockResolvedValue([localBook])
      db.getBookByFingerprint.mockResolvedValue(localBook)

      setupFullReconcileWithRemoteBook(deps, 'aabb-ccdd')

      const service = new BackupSyncService(db, deps.drive, deps.auth)
      await service.syncNow()

      expect(db.restoreBookFromBackup).toHaveBeenCalled()
    })
  })
})
