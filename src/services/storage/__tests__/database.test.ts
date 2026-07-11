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

  describe('rekeyBook', () => {
    async function seedBookWithChildren(db: DatabaseService, bookId: string) {
      await db.upsertBook(bookId, `file:///audio/${bookId}.mp3`, 'Book', 60000, 5000, null, null, null, 1024, FINGERPRINT)
      await db.createClip('clip-1', bookId, 'file:///clips/clip-1.m4a', 1000, 2000, 'note')
      await db.createSession(bookId)
    }

    it('re-keys the book row and all its children, preserving fields', async () => {
      const db = createDb()
      await seedBookWithChildren(db, 'old-id')
      const before = (await db.getBookById('old-id'))!

      const { clipIds, sessionIds } = await db.rekeyBook('old-id', 'new-id')

      expect(await db.getBookById('old-id')).toBeNull()
      const after = (await db.getBookById('new-id'))!
      expect(after.position).toBe(before.position)
      expect(after.updated_at).toBe(before.updated_at) // re-key is not an edit
      expect(after.uri).toBe(before.uri)               // audio untouched

      expect(clipIds).toEqual(['clip-1'])
      expect(sessionIds).toHaveLength(1)
      expect((await db.getClip('clip-1'))!.source_id).toBe('new-id')
      expect((await db.getClipsForBook('old-id'))).toEqual([])
      expect((await db.getSessionById(sessionIds[0]))!.book_id).toBe('new-id')
    })

    it('deletes the old manifest row instead of renaming it', async () => {
      const db = createDb()
      await seedBookWithChildren(db, 'old-id')
      await db.upsertManifestEntry({
        entity_type: 'book', entity_id: 'old-id',
        local_updated_at: 1000, remote_updated_at: null,
        remote_file_id: 'drive-old', remote_audio_file_id: null,
      })

      await db.rekeyBook('old-id', 'new-id')

      expect(await db.getManifestEntry('book', 'old-id')).toBeNull()
      expect(await db.getManifestEntry('book', 'new-id')).toBeNull() // caller's job
    })

    it('re-keys a pending queue row onto the new id', async () => {
      const db = createDb()
      await seedBookWithChildren(db, 'old-id')
      await db.queueChange('book', 'old-id', 'upsert', 1000)

      await db.rekeyBook('old-id', 'new-id')

      const items = await db.getOutboxItems()
      const bookItems = items.filter(i => i.entity_type === 'book')
      expect(bookItems).toHaveLength(1)
      expect(bookItems[0].entity_id).toBe('new-id')
      expect(bookItems[0].updated_at_when_queued).toBe(1000)
    })

    it('merges queue rows on conflict, keeping the newest updated_at_when_queued', async () => {
      const db = createDb()
      await seedBookWithChildren(db, 'old-id')
      await db.queueChange('book', 'old-id', 'upsert', 2000)
      await db.queueChange('book', 'new-id', 'upsert', 1000)

      await db.rekeyBook('old-id', 'new-id')

      const bookItems = (await db.getOutboxItems()).filter(i => i.entity_type === 'book')
      expect(bookItems).toHaveLength(1)
      expect(bookItems[0].entity_id).toBe('new-id')
      expect(bookItems[0].updated_at_when_queued).toBe(2000)
      expect(bookItems[0].attempts).toBe(0)
    })

    it('leaves clip and session queue rows keyed by their own ids', async () => {
      const db = createDb()
      await seedBookWithChildren(db, 'old-id')
      await db.queueChange('clip', 'clip-1', 'upsert', 1000)

      await db.rekeyBook('old-id', 'new-id')

      const clipItems = (await db.getOutboxItems()).filter(i => i.entity_type === 'clip')
      expect(clipItems).toHaveLength(1)
      expect(clipItems[0].entity_id).toBe('clip-1')
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

    it('resets attempts, last_error and backoff on re-queue', async () => {
      const db = createDb()
      await db.queueChange('book', 'book-1', 'upsert', 1000)
      await db.updateOutboxItemAttempt('book', 'book-1', 'network error', 5000, 1000)
      await db.updateOutboxItemAttempt('book', 'book-1', 'network error', 9000, 1000)

      let items = await db.getOutboxItems(9000)
      expect(items[0].attempts).toBe(2)
      expect(items[0].last_error).toBe('network error')
      expect(items[0].next_attempt_at).toBe(9000)

      await db.queueChange('book', 'book-1', 'upsert', 2000)

      items = await db.getOutboxItems(0)
      expect(items[0].attempts).toBe(0)
      expect(items[0].last_error).toBeNull()
      expect(items[0].next_attempt_at).toBe(0)
    })

    it('holds items back until next_attempt_at', async () => {
      const db = createDb()
      await db.queueChange('book', 'book-1', 'upsert', 1000)
      await db.updateOutboxItemAttempt('book', 'book-1', 'boom', 5000, 1000)

      expect(await db.getOutboxItems(4999)).toEqual([])
      expect(await db.getOutboxItems(5000)).toHaveLength(1)
    })

    it('ignores a failure report for an old version (conditional attempt update)', async () => {
      const db = createDb()
      await db.queueChange('book', 'book-1', 'upsert', 1000)
      // Entity re-queued fresh mid-flight (stale detection)
      await db.queueChange('book', 'book-1', 'upsert', 2000)

      // The in-flight push fails for the OLD version — must not stamp backoff
      await db.updateOutboxItemAttempt('book', 'book-1', 'boom', 99999, 1000)

      const items = await db.getOutboxItems(0)
      expect(items).toHaveLength(1)
      expect(items[0].attempts).toBe(0)
      expect(items[0].next_attempt_at).toBe(0)
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
        await db.updateOutboxItemAttempt('clip', 'clip-1', 'boom', 0, 1000)
      }

      expect(await db.getOutboxItems()).toHaveLength(2)
      expect(await db.getQueueCount()).toBe(2)
    })

    it('counts repeatedly failing items separately', async () => {
      const db = createDb()
      await db.queueChange('book', 'book-1', 'upsert', 1000)
      await db.queueChange('clip', 'clip-1', 'upsert', 1000)
      for (let i = 0; i < 3; i++) {
        await db.updateOutboxItemAttempt('clip', 'clip-1', 'boom', 0, 1000)
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

    it('roundtrips remote_audio_version, defaulting to null when omitted', async () => {
      const db = createDb()
      const entry = {
        entity_type: 'clip' as const, entity_id: 'clip-1',
        local_updated_at: 1000, remote_updated_at: null,
        remote_file_id: 'json-1', remote_audio_file_id: 'audio-1',
      }

      await db.upsertManifestEntry(entry)
      expect((await db.getManifestEntry('clip', 'clip-1'))!.remote_audio_version).toBeNull()

      await db.upsertManifestEntry({ ...entry, remote_audio_version: 'md5-abc' })
      expect((await db.getManifestEntry('clip', 'clip-1'))!.remote_audio_version).toBe('md5-abc')

      // Omitting the version on a later upsert resets it (full-row semantics)
      await db.upsertManifestEntry(entry)
      expect((await db.getManifestEntry('clip', 'clip-1'))!.remote_audio_version).toBeNull()
    })
  })
})
