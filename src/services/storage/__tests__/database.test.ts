import { DatabaseService } from '../database'
import { createTestDatabase } from './sqlite_adapter'

function createDb(): DatabaseService {
  return new DatabaseService(createTestDatabase())
}

const FINGERPRINT = new Uint8Array([1, 2, 3, 4])

describe('DatabaseService (real SQLite)', () => {

  describe('migrations', () => {
    it('runs all migrations on a fresh database', async () => {
      const db = createDb()

      // Schema from every migration is present and usable
      await db.upsertBook('book-1', 'file:///audio/book-1.mp3', 'Book', 60000, 0)
      const book = await db.getBookById('book-1')

      expect(book).not.toBeNull()
      expect(book!.speed).toBe(100)          // migration 2
      expect(book!.updated_by).toBeTruthy()  // migration 4
      expect(db.getCheckpoint()).toEqual({ last_page_token: null, last_full_reconcile_at: null })
    })

    it('generates and persists a stable device id', () => {
      const db = createDb()
      const id = db.deviceId

      expect(id).toBeTruthy()
      expect(db.deviceId).toBe(id)
      expect(db.getDeviceId()).toBe(id)
    })
  })

  describe('books', () => {
    it('roundtrips fingerprint blobs through real storage', async () => {
      const db = createDb()
      await db.upsertBook('book-1', 'file:///audio/book-1.mp3', 'Book', 60000, 0, null, null, null, 1024, FINGERPRINT)

      const book = await db.getBookByFingerprint(1024, FINGERPRINT)

      expect(book?.id).toBe('book-1')
      expect(new Uint8Array(book!.fingerprint)).toEqual(FINGERPRINT)
    })

    it('excludes hidden books from getAllBooks but keeps the row', async () => {
      const db = createDb()
      await db.upsertBook('book-1', 'file:///audio/book-1.mp3', 'Book', 60000, 0)
      await db.hideBook('book-1')

      expect(await db.getAllBooks()).toEqual([])
      const row = await db.getBookById('book-1')
      expect(row?.hidden).toBe(true)
      expect(row?.uri).toBeNull()
    })

    it('clears hidden and preserves position when restoring a deleted book', async () => {
      const db = createDb()
      await db.upsertBook('book-1', 'file:///audio/old.mp3', 'Book', 60000, 42000)
      await db.hideBook('book-1')

      // Re-adding the same file takes load_file's restore branch (uri is NULL)
      await db.restoreBook(
        'book-1', 'file:///audio/new.mp3', 'Book', 60000,
        'Title', 'Artist', null, 1024, FINGERPRINT,
      )

      const book = await db.getBookById('book-1')
      expect(book!.hidden).toBe(false)
      expect(book!.uri).toBe('file:///audio/new.mp3')
      expect(book!.position).toBe(42000) // resume position survives delete + re-add
    })

    it('does not bump updated_at on delete or archive (per-device changes)', async () => {
      const db = createDb()
      await db.upsertBook('book-1', 'file:///audio/book-1.mp3', 'Book', 60000, 0)
      await db.upsertBook('book-2', 'file:///audio/book-2.mp3', 'Book', 60000, 0)
      const before1 = (await db.getBookById('book-1'))!
      const before2 = (await db.getBookById('book-2'))!

      await db.hideBook('book-1')
      await db.archiveBook('book-2')

      const after1 = (await db.getBookById('book-1'))!
      const after2 = (await db.getBookById('book-2'))!
      expect(after1.updated_at).toBe(before1.updated_at)
      expect(after1.updated_by).toBe(before1.updated_by)
      expect(after2.updated_at).toBe(before2.updated_at)
      expect(after2.updated_by).toBe(before2.updated_by)
    })
  })

  describe('backup restore', () => {
    it('preserves local hidden when applying a remote book update', async () => {
      const db = createDb()
      await db.upsertBook('book-1', 'file:///audio/book-1.mp3', 'Book', 60000, 0)
      await db.hideBook('book-1')

      await db.restoreBookFromBackup(
        'book-1', 'Book', 60000, 9000,
        Date.now() + 10000, 'other-device',
        'Remote Title', null, null, 1024, FINGERPRINT,
      )

      const book = await db.getBookById('book-1')
      expect(book!.title).toBe('Remote Title')
      expect(book!.position).toBe(9000)
      expect(book!.hidden).toBe(true) // local-only field survives
    })

    it('inserts remote books as visible by default', async () => {
      const db = createDb()
      await db.restoreBookFromBackup(
        'book-1', 'Book', 60000, 0,
        Date.now(), 'other-device',
        null, null, null, 1024, FINGERPRINT,
      )

      const book = await db.getBookById('book-1')
      expect(book!.hidden).toBe(false)
      expect(book!.uri).toBeNull()
    })
  })

  describe('sync queue (outbox)', () => {
    it('deduplicates by entity via the UNIQUE constraint', async () => {
      const db = createDb()
      await db.queueChange('book', 'book-1', 'upsert', 1000)
      await db.queueChange('book', 'book-1', 'upsert', 2000)

      const items = await db.getOutboxItems()
      expect(items).toHaveLength(1)
      expect(items[0].updated_at_when_queued).toBe(2000)
    })

    it('resets attempts and last_error on re-queue', async () => {
      const db = createDb()
      await db.queueChange('book', 'book-1', 'upsert', 1000)
      await db.updateOutboxItemAttempt('book', 'book-1', 'network error')
      await db.updateOutboxItemAttempt('book', 'book-1', 'network error')

      let items = await db.getOutboxItems()
      expect(items[0].attempts).toBe(2)
      expect(items[0].last_error).toBe('network error')

      await db.queueChange('book', 'book-1', 'upsert', 2000)

      items = await db.getOutboxItems()
      expect(items[0].attempts).toBe(0)
      expect(items[0].last_error).toBeNull()
    })

    it('keeps a re-queued row when removing with a stale timestamp (H1)', async () => {
      const db = createDb()
      await db.queueChange('book', 'book-1', 'upsert', 1000)
      // Entity modified mid-upload: stale detection re-queues with fresh timestamp
      await db.queueChange('book', 'book-1', 'upsert', 2000)

      // Push path clears with the ORIGINAL updated_at_when_queued — must be a no-op
      await db.removeOutboxItem('book', 'book-1', 1000)

      const items = await db.getOutboxItems()
      expect(items).toHaveLength(1)
      expect(items[0].updated_at_when_queued).toBe(2000)
    })

    it('removes the row when the timestamp matches', async () => {
      const db = createDb()
      await db.queueChange('book', 'book-1', 'upsert', 1000)
      await db.removeOutboxItem('book', 'book-1', 1000)

      expect(await db.getOutboxItems()).toEqual([])
    })

    it('keeps counting and returning items regardless of attempts (retry forever)', async () => {
      const db = createDb()
      await db.queueChange('book', 'book-1', 'upsert', 1000)
      await db.queueChange('clip', 'clip-1', 'upsert', 1000)
      for (let i = 0; i < 5; i++) {
        await db.updateOutboxItemAttempt('clip', 'clip-1', 'boom')
      }

      expect(await db.getOutboxItems()).toHaveLength(2)
      expect(await db.getQueueCount()).toBe(2)
    })

    it('counts repeatedly failing items separately', async () => {
      const db = createDb()
      await db.queueChange('book', 'book-1', 'upsert', 1000)
      await db.queueChange('clip', 'clip-1', 'upsert', 1000)
      for (let i = 0; i < 3; i++) {
        await db.updateOutboxItemAttempt('clip', 'clip-1', 'boom')
      }

      expect(await db.getFailingCount()).toBe(1)
      expect(await db.getQueueCount()).toBe(2)
    })
  })

  describe('sync manifest', () => {
    it('upserts on the composite primary key', async () => {
      const db = createDb()
      const entry = {
        entity_type: 'clip' as const, entity_id: 'clip-1',
        local_updated_at: 1000, remote_updated_at: null,
        remote_file_id: 'json-1', remote_audio_file_id: 'audio-1',
      }
      await db.upsertManifestEntry(entry)
      await db.upsertManifestEntry({ ...entry, remote_file_id: 'json-2' })

      const all = await db.getAllManifestEntries('clip')
      expect(all).toHaveLength(1)
      expect(all[0].remote_file_id).toBe('json-2')
      expect(all[0].remote_audio_file_id).toBe('audio-1')
    })
  })
})
