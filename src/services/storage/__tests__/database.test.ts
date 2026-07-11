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

    it('filters items and counts by max attempts', async () => {
      const db = createDb()
      await db.queueChange('book', 'book-1', 'upsert', 1000)
      await db.queueChange('clip', 'clip-1', 'upsert', 1000)
      for (let i = 0; i < 3; i++) {
        await db.updateOutboxItemAttempt('clip', 'clip-1', 'boom')
      }

      const items = await db.getOutboxItems(3)
      expect(items).toHaveLength(1)
      expect(items[0].entity_id).toBe('book-1')
      expect(await db.getQueueCount(3)).toBe(1)
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
