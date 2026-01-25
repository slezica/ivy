import { BackupSyncService } from '../sync'
import type { DatabaseService } from '../../storage'
import type { GoogleDriveService } from '../drive'
import type { GoogleAuthService } from '../auth'
import type { SyncQueueService } from '../queue'

/**
 * Tests for the BackupSyncService.
 *
 * Bug #2: Race condition where multiple syncNow() calls could
 * run concurrently before the isSyncing flag was set.
 */

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
})
