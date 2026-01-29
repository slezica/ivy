import { BackupSyncService } from '../sync'
import type { DatabaseService, Book } from '../../storage'
import type { GoogleDriveService } from '../drive'
import type { GoogleAuthService } from '../auth'
import type { SyncQueueService } from '../queue'

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
      getAllBooks: jest.fn(() => []),
      getAllClips: jest.fn(() => []),
      getAllManifestEntries: jest.fn(() => []),
      getLastSyncTime: jest.fn(() => null),
      setLastSyncTime: jest.fn(),
      upsertManifestEntry: jest.fn(),
      deleteManifestEntry: jest.fn(),
      getBookById: jest.fn(),
      getBookByFingerprint: jest.fn(() => null),
      getClip: jest.fn(),
      restoreBookFromBackup: jest.fn(),
      restoreClipFromBackup: jest.fn(),
    } as any

    const drive: jest.Mocked<GoogleDriveService> = {
      listFiles: jest.fn(() => Promise.resolve([])),
      uploadFile: jest.fn(),
      downloadFile: jest.fn(),
      deleteFile: jest.fn(),
    } as any

    const auth: jest.Mocked<GoogleAuthService> = {
      initialize: jest.fn(() => Promise.resolve()),
      isAuthenticated: jest.fn(() => true),
      getAccessToken: jest.fn(() => Promise.resolve('mock-token')),
      signIn: jest.fn(() => Promise.resolve(true)),
    } as any

    const syncQueue: jest.Mocked<SyncQueueService> = {
      getCount: jest.fn(() => 0),
      processQueue: jest.fn(() => Promise.resolve({ processed: 0, errors: [] })),
    } as any

    return { db, drive, auth, syncQueue }
  }

  describe('syncNow', () => {
    it('prevents concurrent sync operations', async () => {
      const { db, drive, auth, syncQueue } = createMockDeps()

      let performSyncStarted = 0

      // Use db.setLastSyncTime as marker - it's called at the end of performSync
      db.setLastSyncTime.mockImplementation(() => {
        performSyncStarted++
      })

      // Make sync take some time
      drive.listFiles.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return []
      })

      const service = new BackupSyncService(db, drive, auth, syncQueue)

      // Fire multiple sync calls with slight delays to ensure they interleave
      const p1 = service.syncNow()
      const p2 = service.syncNow()
      const p3 = service.syncNow()

      await Promise.all([p1, p2, p3])

      // Only one sync should have completed
      expect(performSyncStarted).toBe(1)
    })

    it('allows subsequent sync after first completes', async () => {
      const { db, drive, auth, syncQueue } = createMockDeps()

      let syncCompletedCount = 0
      db.setLastSyncTime.mockImplementation(() => {
        syncCompletedCount++
      })

      const service = new BackupSyncService(db, drive, auth, syncQueue)

      // First sync
      await service.syncNow()
      expect(syncCompletedCount).toBe(1)

      // Second sync (should work since first completed)
      await service.syncNow()
      expect(syncCompletedCount).toBe(2)
    })

    it('resets sync flag on error', async () => {
      const { db, drive, auth, syncQueue } = createMockDeps()

      let authInitCount = 0
      auth.initialize.mockImplementation(async () => {
        authInitCount++
        if (authInitCount === 1) {
          throw new Error('Network error')
        }
      })

      const service = new BackupSyncService(db, drive, auth, syncQueue)

      // First sync fails (auth.initialize throws)
      await service.syncNow()
      expect(authInitCount).toBe(1)

      // Second sync should be allowed (flag was reset despite error)
      await service.syncNow()
      expect(authInitCount).toBe(2)
    })
  })

  describe('autoSync', () => {
    it('prevents concurrent auto-sync operations', async () => {
      const { db, drive, auth, syncQueue } = createMockDeps()

      let syncCompletedCount = 0
      db.setLastSyncTime.mockImplementation(() => {
        syncCompletedCount++
      })

      // Make sync take some time
      drive.listFiles.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return []
      })

      const service = new BackupSyncService(db, drive, auth, syncQueue)

      // Fire multiple auto-sync calls
      const p1 = service.autoSync()
      const p2 = service.autoSync()
      const p3 = service.autoSync()

      await Promise.all([p1, p2, p3])

      // Only one sync should have completed
      expect(syncCompletedCount).toBe(1)
    })

    it('skips sync when not authenticated', async () => {
      const { db, drive, auth, syncQueue } = createMockDeps()

      auth.getAccessToken.mockResolvedValue(null)

      let syncCompletedCount = 0
      db.setLastSyncTime.mockImplementation(() => {
        syncCompletedCount++
      })

      const service = new BackupSyncService(db, drive, auth, syncQueue)

      await service.autoSync()

      // Sync should not have started
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
        title: 'My Book',
        artist: 'Author',
        artwork: null,
        file_size: FILE_SIZE,
        fingerprint: FINGERPRINT,
        hidden: false,
      }
    }

    function setupSyncWithRemoteBook(deps: ReturnType<typeof createMockDeps>, remoteId: string) {
      const { db, drive } = deps
      const remoteBookJson = JSON.stringify({
        id: remoteId,
        name: 'Book remote',
        duration: 60000,
        position: 3000,
        updated_at: 2000,
        title: 'My Book',
        artist: 'Author',
        artwork: null,
        file_size: FILE_SIZE,
        fingerprint: FINGERPRINT_B64,
        hidden: false,
      })

      // Drive returns one remote book JSON file
      drive.listFiles.mockImplementation(async (folder: string) => {
        if (folder === 'books') {
          return [{ id: 'drive-file-1', name: `book_${remoteId}.json`, modifiedTime: new Date(2000).toISOString() }]
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

      // Local state: one book
      db.getAllBooks.mockReturnValue([localBook])

      // Fingerprint lookup returns the local book (same content, different ID)
      db.getBookByFingerprint.mockReturnValue(localBook)

      setupSyncWithRemoteBook(deps, 'b0b0-b0b0')

      const service = new BackupSyncService(db, deps.drive, deps.auth, deps.syncQueue)
      await service.syncNow()

      // restoreBookFromBackup should NOT have been called — the download was skipped
      expect(db.restoreBookFromBackup).not.toHaveBeenCalled()
    })

    it('allows download when no fingerprint match exists', async () => {
      const deps = createMockDeps()
      const { db } = deps

      // No local books, no fingerprint match
      db.getBookByFingerprint.mockReturnValue(null)

      setupSyncWithRemoteBook(deps, 'b0b0-b0b0')

      const service = new BackupSyncService(db, deps.drive, deps.auth, deps.syncQueue)
      await service.syncNow()

      // restoreBookFromBackup SHOULD have been called for the remote book
      expect(db.restoreBookFromBackup).toHaveBeenCalled()
      expect(db.restoreBookFromBackup.mock.calls[0][0]).toBe('b0b0-b0b0')
    })

    it('allows download when fingerprint matches the same ID (not a duplicate)', async () => {
      const deps = createMockDeps()
      const { db } = deps
      const localBook = createLocalBook('aabb-ccdd')

      db.getAllBooks.mockReturnValue([localBook])
      // Fingerprint matches, but it's the same book ID — this is an update, not a duplicate
      db.getBookByFingerprint.mockReturnValue(localBook)

      setupSyncWithRemoteBook(deps, 'aabb-ccdd')

      const service = new BackupSyncService(db, deps.drive, deps.auth, deps.syncQueue)
      await service.syncNow()

      // This is a legitimate update to the same book — should proceed
      expect(db.restoreBookFromBackup).toHaveBeenCalled()
    })
  })
})
