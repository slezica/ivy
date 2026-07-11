/**
 * Sync engine scenarios
 *
 * End-to-end sync flows through the real BackupSyncService, real
 * DatabaseService (real SQLite) and the scripted FakeDrive.
 */

import RNFS from 'react-native-fs'

import { FakeDrive, createSyncHarness, SyncHarness } from './harness'

// IDs must be hex + hyphens to match the sync filename regex
const BOOK_ID = 'aaa00001-0000-0000-0000-000000000001'
const CLIP_ID = 'ccc00001-0000-0000-0000-000000000001'

const FINGERPRINT = new Uint8Array([1, 2, 3, 4])
const FINGERPRINT_B64 = btoa(String.fromCharCode(...FINGERPRINT))

async function addBook(device: SyncHarness, id: string = BOOK_ID): Promise<void> {
  await device.db.upsertBook(
    id, `file:///audio/${id}.mp3`, 'Test Book', 60000, 5000,
    'Test Title', 'Test Artist', null, 1024, FINGERPRINT,
  )
}

async function addClip(device: SyncHarness, id: string = CLIP_ID, sourceId: string = BOOK_ID): Promise<void> {
  const clip = await device.db.createClip(id, sourceId, `file:///clips/${id}.m4a`, 10000, 5000, 'A note')
  await device.db.queueChange('clip', id, 'upsert', clip.updated_at)
}

// Mirrors the delete_clip action: optimistic local delete + queued delete op
async function deleteClip(device: SyncHarness, id: string = CLIP_ID): Promise<void> {
  await device.db.deleteClip(id)
  await device.db.queueChange('clip', id, 'delete')
}

/** Collect the terminal error of each sync run (null = clean). */
function trackSyncErrors(device: SyncHarness): (string | null)[] {
  const errors: (string | null)[] = []
  device.sync.on('status', (status) => {
    if (!status.isSyncing) errors.push(status.error)
  })
  return errors
}

function remoteClipJson(overrides: Record<string, any> = {}): string {
  return JSON.stringify({
    id: CLIP_ID,
    source_id: BOOK_ID,
    start: 10000,
    duration: 5000,
    note: 'A note',
    transcription: null,
    created_at: 4000,
    updated_at: 5000,
    updated_by: 'device-remote',
    ...overrides,
  })
}

function remoteBookJson(overrides: Record<string, any> = {}): string {
  return JSON.stringify({
    id: BOOK_ID,
    name: 'Test Book',
    duration: 60000,
    position: 5000,
    updated_at: 5000,
    updated_by: 'device-remote',
    title: 'Remote Title',
    artist: 'Remote Artist',
    artwork: null,
    file_size: 1024,
    fingerprint: FINGERPRINT_B64,
    speed: 100,
    ...overrides,
  })
}

describe('sync scenarios', () => {
  // Strictly increasing Date.now so every write gets a distinct timestamp
  // (LWW comparisons stay deterministic regardless of test speed)
  let now = 1_000_000
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => ++now)
  })
  afterEach(() => {
    ;(Date.now as unknown as jest.Mock).mockRestore()
  })

  it('pushes a local book to Drive and bootstraps it on a second device', async () => {
    const drive = new FakeDrive()
    const deviceA = createSyncHarness(drive)
    const deviceB = createSyncHarness(drive)

    await addBook(deviceA)
    await deviceA.sync.syncNow() // full reconcile queues the local-only book, push uploads it

    const remote = drive.readJson(`book_${BOOK_ID}.json`)
    expect(remote.id).toBe(BOOK_ID)
    expect(remote.position).toBe(5000)
    expect(await deviceA.db.getOutboxItems()).toEqual([])

    await deviceB.sync.syncNow() // first sync → full reconcile downloads it

    const book = await deviceB.db.getBookById(BOOK_ID)
    expect(book).not.toBeNull()
    expect(book!.title).toBe('Test Title')
    expect(book!.position).toBe(5000)
    expect(book!.uri).toBeNull() // audio never syncs
  })

  it('propagates an edit through the incremental change feed', async () => {
    const drive = new FakeDrive()
    const deviceA = createSyncHarness(drive)
    const deviceB = createSyncHarness(drive)

    await addBook(deviceA)
    await deviceA.sync.syncNow()
    await deviceB.sync.syncNow()

    await deviceA.db.updateBookMetadata(BOOK_ID, 'New Title', 'New Artist')
    const edited = await deviceA.db.getBookById(BOOK_ID)
    await deviceA.db.queueChange('book', BOOK_ID, 'upsert', edited!.updated_at)
    await deviceA.sync.syncNow()

    await deviceB.sync.syncNow() // incremental pull

    const book = await deviceB.db.getBookById(BOOK_ID)
    expect(book!.title).toBe('New Title')
    expect(book!.artist).toBe('New Artist')
  })

  it('round-trips a clip with its audio file', async () => {
    const drive = new FakeDrive()
    const deviceA = createSyncHarness(drive)
    const deviceB = createSyncHarness(drive)

    await addBook(deviceA)
    const clip = await deviceA.db.createClip(
      CLIP_ID, BOOK_ID, `file:///clips/${CLIP_ID}.m4a`, 10000, 5000, 'A note',
    )
    await deviceA.db.queueChange('clip', CLIP_ID, 'upsert', clip.updated_at)
    await deviceA.sync.syncNow()

    expect(drive.getFileByName(`clip_${CLIP_ID}.json`)).toBeDefined()
    expect(drive.getFileByName(`clip_${CLIP_ID}.m4a`)).toBeDefined()

    await deviceB.sync.syncNow()

    const remoteClip = await deviceB.db.getClip(CLIP_ID)
    expect(remoteClip).not.toBeNull()
    expect(remoteClip!.note).toBe('A note')
    expect(remoteClip!.uri).toContain(`${CLIP_ID}.m4a`)
  })

  it('records push failures in the real outbox and recovers on the next sync', async () => {
    const drive = new FakeDrive()
    const device = createSyncHarness(drive)

    await addBook(device)
    drive.failNext('uploadFile', new Error('Network error'))
    await device.sync.syncNow()

    const items = await device.db.getOutboxItems(Number.MAX_SAFE_INTEGER)
    expect(items).toHaveLength(1)
    expect(items[0].attempts).toBe(1)
    expect(items[0].last_error).toBe('Network error')

    now += 30_000 // first backoff window (2^0 × 30s)
    await device.sync.syncNow()

    expect(await device.db.getOutboxItems(Number.MAX_SAFE_INTEGER)).toEqual([])
    expect(drive.getFileByName(`book_${BOOK_ID}.json`)).toBeDefined()
  })

  it('respects the backoff schedule before retrying a failed push', async () => {
    const drive = new FakeDrive()
    const device = createSyncHarness(drive)

    await addBook(device)
    drive.failNext('uploadFile', new Error('Network error'), 2)
    await device.sync.syncNow() // attempt 1 fails → 30s backoff

    // Before the window elapses the item is held back — no upload attempted
    await device.sync.syncNow()
    expect(drive.getFileByName(`book_${BOOK_ID}.json`)).toBeUndefined()
    let [item] = await device.db.getOutboxItems(Number.MAX_SAFE_INTEGER)
    expect(item.attempts).toBe(1)

    now += 30_000
    await device.sync.syncNow() // attempt 2 fails → backoff doubles to 60s

    ;[item] = await device.db.getOutboxItems(Number.MAX_SAFE_INTEGER)
    expect(item.attempts).toBe(2)

    now += 30_000 // only half the doubled window — still held back
    await device.sync.syncNow()
    expect(drive.getFileByName(`book_${BOOK_ID}.json`)).toBeUndefined()

    now += 30_000 // full 60s elapsed — retried and succeeds
    await device.sync.syncNow()
    expect(drive.getFileByName(`book_${BOOK_ID}.json`)).toBeDefined()
    expect(await device.db.getOutboxItems(Number.MAX_SAFE_INTEGER)).toEqual([])
  })

  it('resets backoff when the entity is re-queued by a fresh edit', async () => {
    const drive = new FakeDrive()
    const device = createSyncHarness(drive)

    await addBook(device)
    drive.failNext('uploadFile', new Error('Network error'))
    await device.sync.syncNow() // push fails → 30s backoff stamped

    // A fresh local edit re-queues the entity — the backoff must reset
    await device.db.updateBookMetadata(BOOK_ID, 'New Title', null)
    const edited = await device.db.getBookById(BOOK_ID)
    await device.db.queueChange('book', BOOK_ID, 'upsert', edited!.updated_at)

    await device.sync.syncNow() // no waiting — pushed immediately

    expect(drive.readJson(`book_${BOOK_ID}.json`).title).toBe('New Title')
    expect(await device.db.getOutboxItems(Number.MAX_SAFE_INTEGER)).toEqual([])
  })

  describe('books: local-only hidden', () => {
    it('omits hidden from the uploaded payload', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)

      await addBook(device)
      await device.db.hideBook(BOOK_ID)
      await device.db.queueChange('book', BOOK_ID, 'upsert')
      await device.sync.syncNow()

      const remote = drive.readJson(`book_${BOOK_ID}.json`)
      expect(remote).not.toHaveProperty('hidden')
    })

    it('keeps a locally deleted book hidden when a remote update arrives', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)

      await addBook(device)
      await device.db.hideBook(BOOK_ID)

      // A newer remote version of the book arrives (edited on another device)
      drive.putFile('books', `book_${BOOK_ID}.json`, remoteBookJson({ updated_at: Date.now() + 10_000_000 }))
      await device.sync.syncNow()

      const book = await device.db.getBookById(BOOK_ID)
      expect(book!.title).toBe('Remote Title') // remote edit applied
      expect(book!.hidden).toBe(true)          // local deletion untouched
      expect(await device.db.getAllBooks()).toEqual([])
    })

    it('does not sync a local deletion to other devices', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceA)
      await deviceA.sync.syncNow()
      await deviceB.sync.syncNow()

      await deviceA.db.hideBook(BOOK_ID)
      const remoteBefore = drive.readJson(`book_${BOOK_ID}.json`)
      await deviceA.sync.syncNow()

      // Nothing queued, nothing pushed — the remote payload is untouched
      expect(await deviceA.db.getOutboxItems()).toEqual([])
      expect(drive.readJson(`book_${BOOK_ID}.json`)).toEqual(remoteBefore)

      // The other device keeps its copy
      await deviceB.sync.syncNow()
      const bookOnB = await deviceB.db.getBookById(BOOK_ID)
      expect(bookOnB!.hidden).toBe(false)
    })

    it('does not trigger a local-ahead re-queue when a book is archived', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)

      await addBook(device)
      await device.sync.syncNow() // uploads; the upload lands in the change feed
      const before = (await device.db.getBookById(BOOK_ID))!.updated_at

      await device.db.archiveBook(BOOK_ID)
      await device.sync.syncNow() // pulls its own change — must reconcile as same-version

      expect(await device.db.getOutboxItems()).toEqual([])
      expect((await device.db.getBookById(BOOK_ID))!.updated_at).toBe(before)
    })

    it('ignores hidden in legacy remote payloads on bootstrap', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)

      // Old-code devices wrote hidden into the payload — readers must ignore it
      drive.putFile('books', `book_${BOOK_ID}.json`, remoteBookJson({ hidden: true }))
      await device.sync.syncNow()

      const book = await device.db.getBookById(BOOK_ID)
      expect(book).not.toBeNull()
      expect(book!.hidden).toBe(false)
    })
  })

  describe('clips and sessions: tombstoned deletion', () => {
    it('rewrites the remote clip as a full-payload tombstone on delete', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)

      await addBook(deviceA)
      await addClip(deviceA)
      await deviceA.sync.syncNow()
      await deviceA.sync.syncNow() // consume the upload echo while the clip is live
      const liveUpdatedAt = (await deviceA.db.getClip(CLIP_ID))!.updated_at

      await deleteClip(deviceA)
      await deviceA.sync.syncNow()

      // JSON rewritten in place: full last-known payload plus deleted marker
      const tombstone = drive.readJson(`clip_${CLIP_ID}.json`)
      expect(tombstone.deleted).toBe(true)
      expect(tombstone.note).toBe('A note')
      expect(tombstone.source_id).toBe(BOOK_ID)
      expect(tombstone.updated_at).toBeGreaterThan(liveUpdatedAt) // deletion time competes under LWW

      // Audio is hard-deleted; the manifest row survives with the dead audio id nulled
      expect(drive.getFileByName(`clip_${CLIP_ID}.m4a`)).toBeUndefined()
      const manifest = await deviceA.db.getManifestEntry('clip', CLIP_ID)
      expect(manifest!.remote_file_id).not.toBeNull()
      expect(manifest!.remote_audio_file_id).toBeNull()
      expect(await deviceA.db.getOutboxItems()).toEqual([])
    })

    it('drops a stale tombstone when a remote edit is newer than the deletion', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceA)
      await addClip(deviceA)
      await deviceA.sync.syncNow()
      await deviceB.sync.syncNow() // B bootstraps the clip

      // A deletes offline; B edits afterwards and syncs first
      await deleteClip(deviceA)
      await deviceB.db.updateClip(CLIP_ID, { note: 'Edited after delete' })
      const edited = await deviceB.db.getClip(CLIP_ID)
      await deviceB.db.queueChange('clip', CLIP_ID, 'upsert', edited!.updated_at)
      await deviceB.sync.syncNow()

      // A's pull restores the edited clip; A's push drops the stale tombstone
      await deviceA.sync.syncNow()

      expect(drive.readJson(`clip_${CLIP_ID}.json`).deleted).toBeUndefined()
      expect(drive.getFileByName(`clip_${CLIP_ID}.m4a`)).toBeDefined()
      expect(await deviceA.db.getOutboxItems()).toEqual([])
      expect((await deviceA.db.getClip(CLIP_ID))!.note).toBe('Edited after delete')
      expect((await deviceB.db.getClip(CLIP_ID))!.note).toBe('Edited after delete')
    })

    it('silently drops a delete for a clip that never synced', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)
      const errors = trackSyncErrors(device)

      await addBook(device)
      await addClip(device)
      await deleteClip(device)
      await device.sync.syncNow()

      expect(errors).toEqual([null])
      expect(await device.db.getOutboxItems()).toEqual([])
      expect(drive.getFileByName(`clip_${CLIP_ID}.json`)).toBeUndefined()
    })

    it('drops the queue item and manifest when the remote was purged', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)
      const errors = trackSyncErrors(device)

      await addBook(device)
      await addClip(device)
      await device.sync.syncNow()
      await device.sync.syncNow() // consume the upload echo

      // User purged Drive out-of-band, then the clip is deleted locally
      drive.removeFile(drive.getFileByName(`clip_${CLIP_ID}.json`)!.id)
      drive.removeFile(drive.getFileByName(`clip_${CLIP_ID}.m4a`)!.id)
      await deleteClip(device)
      await device.sync.syncNow()

      expect(errors[errors.length - 1]).toBeNull()
      expect(await device.db.getOutboxItems()).toEqual([])
      expect(await device.db.getManifestEntry('clip', CLIP_ID)).toBeNull()
    })

    it('propagates a clip deletion to another device', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceA)
      await addClip(deviceA)
      await deviceA.sync.syncNow()
      await deviceA.sync.syncNow() // consume the upload echo
      await deviceB.sync.syncNow() // B bootstraps the clip
      expect(await deviceB.db.getClip(CLIP_ID)).not.toBeNull()

      await deleteClip(deviceA)
      await deviceA.sync.syncNow() // pushes the tombstone
      await deviceB.sync.syncNow() // B pulls it

      expect(await deviceB.db.getClip(CLIP_ID)).toBeNull()
      expect(RNFS.unlink).toHaveBeenCalledWith(`/mock/documents/clips/${CLIP_ID}.m4a`)
      const manifest = await deviceB.db.getManifestEntry('clip', CLIP_ID)
      expect(manifest!.remote_audio_file_id).toBeNull() // dead id nulled on the puller too
    })

    it('propagates a session deletion to another device', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceA)
      const session = await deviceA.db.createSession(BOOK_ID)
      await deviceA.db.queueChange('session', session.id, 'upsert', session.updated_at)
      await deviceA.sync.syncNow()
      await deviceA.sync.syncNow() // consume the upload echo
      await deviceB.sync.syncNow()
      expect(await deviceB.db.getSessionById(session.id)).not.toBeNull()

      await deviceA.db.deleteSession(session.id)
      await deviceA.db.queueChange('session', session.id, 'delete')
      await deviceA.sync.syncNow()
      await deviceB.sync.syncNow()

      expect(await deviceB.db.getSessionById(session.id)).toBeNull()
      expect(drive.readJson(`session_${session.id}.json`).deleted).toBe(true)
    })

    it('applies a newer tombstone over an unsynced local edit', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceA)
      await addClip(deviceA)
      await deviceA.sync.syncNow()
      await deviceA.sync.syncNow()
      await deviceB.sync.syncNow()

      // B edits first, then A deletes — the deletion is newer and wins
      await deviceB.db.updateClip(CLIP_ID, { note: 'Doomed edit' })
      const edited = await deviceB.db.getClip(CLIP_ID)
      await deviceB.db.queueChange('clip', CLIP_ID, 'upsert', edited!.updated_at)
      await deleteClip(deviceA)
      await deviceA.sync.syncNow()

      await deviceB.sync.syncNow() // tombstone wins the pull; the stale upsert finds no row

      expect(await deviceB.db.getClip(CLIP_ID)).toBeNull()
      expect(await deviceB.db.getOutboxItems()).toEqual([])
      expect(drive.readJson(`clip_${CLIP_ID}.json`).deleted).toBe(true)
    })

    it('resurrects a clip when a local edit is newer than the tombstone', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceA)
      await addClip(deviceA)
      await deviceA.sync.syncNow()
      await deviceA.sync.syncNow()
      await deviceB.sync.syncNow()

      // A deletes and syncs; B then edits — the edit is newer and un-deletes
      await deleteClip(deviceA)
      await deviceA.sync.syncNow()
      await deviceB.db.updateClip(CLIP_ID, { note: 'Edited after delete' })
      const edited = await deviceB.db.getClip(CLIP_ID)
      await deviceB.db.queueChange('clip', CLIP_ID, 'upsert', edited!.updated_at)

      await deviceB.sync.syncNow() // local wins the pull; push re-uploads the live entity

      expect((await deviceB.db.getClip(CLIP_ID))!.note).toBe('Edited after delete')
      const remote = drive.readJson(`clip_${CLIP_ID}.json`)
      expect(remote.deleted).toBeUndefined()
      expect(remote.note).toBe('Edited after delete')
      // The old audio id died with the tombstone — a fresh audio file was created
      expect(drive.getFileByName(`clip_${CLIP_ID}.m4a`)).toBeDefined()

      await deviceA.sync.syncNow() // A pulls the resurrection

      expect((await deviceA.db.getClip(CLIP_ID))!.note).toBe('Edited after delete')
    })

    it('treats deleting an already-tombstoned clip as a no-op', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceA)
      await addClip(deviceA)
      await deviceA.sync.syncNow()
      await deviceA.sync.syncNow()
      await deviceB.sync.syncNow()
      const errors = trackSyncErrors(deviceB)

      await deleteClip(deviceA)
      await deviceA.sync.syncNow()
      await deleteClip(deviceB) // B deletes too, before pulling A's tombstone
      const tombstoneBefore = drive.readJson(`clip_${CLIP_ID}.json`)

      await deviceB.sync.syncNow()

      expect(errors).toEqual([null])
      expect(await deviceB.db.getClip(CLIP_ID)).toBeNull()
      expect(await deviceB.db.getOutboxItems()).toEqual([])
      // B dropped its own tombstone — A's stands untouched
      expect(drive.readJson(`clip_${CLIP_ID}.json`)).toEqual(tombstoneBefore)
    })

    it('applies tombstones during a full reconcile', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceA)
      await addClip(deviceA)
      const session = await deviceA.db.createSession(BOOK_ID)
      await deviceA.db.queueChange('session', session.id, 'upsert', session.updated_at)
      await deviceA.sync.syncNow()
      await deviceA.sync.syncNow()
      await deviceB.sync.syncNow() // B bootstraps clip and session
      const errors = trackSyncErrors(deviceB)

      await deleteClip(deviceA)
      await deviceA.db.deleteSession(session.id)
      await deviceA.db.queueChange('session', session.id, 'delete')
      await deviceA.sync.syncNow()

      // B lost its page token — recovery goes through the full reconcile path
      await deviceB.db.clearCheckpoint()
      await deviceB.sync.syncNow()

      expect(errors).toEqual([null])
      expect(await deviceB.db.getClip(CLIP_ID)).toBeNull()
      expect(await deviceB.db.getSessionById(session.id)).toBeNull()
      expect(await deviceB.db.getOutboxItems()).toEqual([])
    })

    it('ignores tombstones for never-seen entities on bootstrap', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)

      await addBook(deviceA)
      await addClip(deviceA)
      await deviceA.sync.syncNow()
      await deviceA.sync.syncNow()
      await deleteClip(deviceA)
      await deviceA.sync.syncNow()

      // A fresh device bootstraps after the tombstone exists
      const deviceC = createSyncHarness(drive)
      const errors = trackSyncErrors(deviceC)
      await deviceC.sync.syncNow()

      expect(errors).toEqual([null])
      expect(await deviceC.db.getBookById(BOOK_ID)).not.toBeNull()
      expect(await deviceC.db.getClip(CLIP_ID)).toBeNull()
    })

    it('applies its own tombstone echo as a graceful no-op', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)
      const errors = trackSyncErrors(device)

      await addBook(device)
      await addClip(device)
      await device.sync.syncNow()
      await device.sync.syncNow()
      await deleteClip(device)
      await device.sync.syncNow() // pushes the tombstone
      await device.sync.syncNow() // pulls its own tombstone back

      expect(errors).toEqual([null, null, null, null])
      expect(await device.db.getClip(CLIP_ID)).toBeNull()
      expect(await device.db.getOutboxItems()).toEqual([])
    })
  })

  describe('book identity merge', () => {
    // Same audio imported independently on two devices: the fingerprint
    // matches, the ids differ — the lexicographically smaller id wins
    const SMALL_ID = BOOK_ID // 'aaa…'
    const LARGE_ID = 'bbb00001-0000-0000-0000-000000000001'
    const CLIP_A = CLIP_ID
    const CLIP_B = 'ccc00002-0000-0000-0000-000000000002'

    it('merges a double-imported book toward the smaller id on both devices', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceA, SMALL_ID)
      await deviceA.sync.syncNow() // uploads book_{small}

      await addBook(deviceB, LARGE_ID) // same audio, independent import
      await deviceB.sync.syncNow() // bootstrap pulls the twin → B merges, pushes merged book
      await deviceA.sync.syncNow() // A pulls B's merged upsert

      // One surviving id everywhere, each device keeping its own audio
      expect(await deviceB.db.getBookById(LARGE_ID)).toBeNull()
      const onB = await deviceB.db.getBookById(SMALL_ID)
      expect(onB).not.toBeNull()
      expect(onB!.uri).toContain(LARGE_ID) // B's audio file survives the re-key
      const onA = await deviceA.db.getBookById(SMALL_ID)
      expect(onA!.uri).toContain(SMALL_ID)

      // The losing id never reached Drive; the manifest points at the survivor
      expect(drive.getFileByName(`book_${LARGE_ID}.json`)).toBeUndefined()
      const manifest = await deviceB.db.getManifestEntry('book', SMALL_ID)
      expect(manifest!.remote_file_id).toBe(drive.getFileByName(`book_${SMALL_ID}.json`)!.id)
      expect(await deviceB.db.getManifestEntry('book', LARGE_ID)).toBeNull()
      expect(await deviceB.db.getOutboxItems()).toEqual([])
    })

    it('skips the remote twin and records nothing when holding the smaller id', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceB, LARGE_ID)
      await deviceB.sync.syncNow() // uploads book_{large}

      await addBook(deviceA, SMALL_ID)
      await deviceA.sync.syncNow() // pulls the larger twin → skip; pushes its own book

      expect(await deviceA.db.getBookById(LARGE_ID)).toBeNull()
      expect(await deviceA.db.getManifestEntry('book', LARGE_ID)).toBeNull()
      expect(await deviceA.db.getOutboxItems()).toEqual([])
      expect(drive.getFileByName(`book_${SMALL_ID}.json`)).toBeDefined()
    })

    it('converges without flapping when both devices pull each other\'s twin', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      // Both twins land on Drive before either device sees the other's
      await addBook(deviceB, LARGE_ID)
      await deviceB.sync.syncNow()
      await addBook(deviceA, SMALL_ID)
      await deviceA.sync.syncNow() // pulls large → skip (smaller local id wins)
      await deviceB.sync.syncNow() // pulls small → merge

      // Settle: everyone pulls the merge outcome
      await deviceA.sync.syncNow()
      await deviceB.sync.syncNow()

      const onA = (await deviceA.db.getBookById(SMALL_ID))!
      const onB = (await deviceB.db.getBookById(SMALL_ID))!
      expect(await deviceA.db.getBookById(LARGE_ID)).toBeNull()
      expect(await deviceB.db.getBookById(LARGE_ID)).toBeNull()
      expect(onA.updated_at).toBe(onB.updated_at) // same winning version

      // No flapping: further rounds change nothing and queue nothing
      await deviceA.sync.syncNow()
      await deviceB.sync.syncNow()
      expect((await deviceA.db.getBookById(SMALL_ID))!.updated_at).toBe(onA.updated_at)
      expect((await deviceB.db.getBookById(SMALL_ID))!.updated_at).toBe(onB.updated_at)
      expect(await deviceA.db.getOutboxItems()).toEqual([])
      expect(await deviceB.db.getOutboxItems()).toEqual([])
    })

    it('retires the superseded remote copy with a merged_into tombstone', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      // Twins on Drive: B uploaded its copy before ever seeing A's
      await addBook(deviceB, LARGE_ID)
      await deviceB.sync.syncNow()
      await addBook(deviceA, SMALL_ID)
      await deviceA.sync.syncNow()

      await deviceB.sync.syncNow() // pulls the smaller twin → merges and retires its copy

      // Full-payload tombstone in place of the losing JSON — no live twin
      const tombstone = drive.readJson(`book_${LARGE_ID}.json`)
      expect(tombstone.deleted).toBe(true)
      expect(tombstone.merged_into).toBe(SMALL_ID)
      expect(tombstone.name).toBe('Test Book')
      expect(drive.readJson(`book_${SMALL_ID}.json`).deleted).toBeUndefined()
      expect(await deviceB.db.getOutboxItems()).toEqual([])

      // The tombstone echo is harmless on both devices
      const errorsA = trackSyncErrors(deviceA)
      const errorsB = trackSyncErrors(deviceB)
      await deviceA.sync.syncNow()
      await deviceB.sync.syncNow()
      expect(errorsA).toEqual([null])
      expect(errorsB).toEqual([null])
      expect(await deviceA.db.getBookById(LARGE_ID)).toBeNull()
      expect(await deviceB.db.getBookById(LARGE_ID)).toBeNull()
    })

    it('adopts the surviving id when the tombstone arrives before the merged book', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)
      const errors = trackSyncErrors(device)

      await addBook(device, LARGE_ID) // this device holds the audio
      await addClip(device, CLIP_B, LARGE_ID)
      const session = await device.db.createSession(LARGE_ID)
      await device.sync.syncNow() // uploads book + clip
      await device.sync.syncNow() // consume the upload echoes

      // Another device merged large → small; only the tombstone reaches us yet
      const largeFile = drive.getFileByName(`book_${LARGE_ID}.json`)!
      await drive.updateFile(largeFile.id, remoteBookJson({
        id: LARGE_ID, deleted: true, merged_into: SMALL_ID, updated_at: Date.now(),
      }))
      await device.sync.syncNow()

      expect(errors[errors.length - 1]).toBeNull()
      expect(await device.db.getBookById(LARGE_ID)).toBeNull()
      const survivor = await device.db.getBookById(SMALL_ID)
      expect(survivor).not.toBeNull()
      expect(survivor!.uri).toContain(LARGE_ID) // audio survives the adoption
      expect((await device.db.getClip(CLIP_B))!.source_id).toBe(SMALL_ID)
      expect((await device.db.getSessionById(session.id))!.book_id).toBe(SMALL_ID)
      expect(await device.db.getManifestEntry('book', LARGE_ID)).toBeNull()

      // The re-keyed children re-uploaded — their remote copies were the only
      // ones still naming the retired id
      expect(drive.readJson(`clip_${CLIP_B}.json`).source_id).toBe(SMALL_ID)
      expect(drive.readJson(`session_${session.id}.json`).book_id).toBe(SMALL_ID)
      expect(await device.db.getOutboxItems()).toEqual([])
    })

    it('transfers audio to an audio-less survivor when both rows exist', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)

      // Bootstrapped survivor (no audio) — distinct fingerprint so the
      // bootstrap itself doesn't trigger the merge path
      const OTHER_FP = btoa(String.fromCharCode(9, 9, 9, 9))
      drive.putFile('books', `book_${SMALL_ID}.json`, remoteBookJson({ id: SMALL_ID, fingerprint: OTHER_FP }))
      await addBook(device, LARGE_ID) // locally imported copy with audio
      await addClip(device, CLIP_B, LARGE_ID)
      await device.sync.syncNow() // bootstraps small (uri null), uploads large
      await device.sync.syncNow() // consume the upload echoes
      expect((await device.db.getBookById(SMALL_ID))!.uri).toBeNull()

      // Another device retires large in favor of small
      const largeFile = drive.getFileByName(`book_${LARGE_ID}.json`)!
      await drive.updateFile(largeFile.id, remoteBookJson({
        id: LARGE_ID, deleted: true, merged_into: SMALL_ID, updated_at: Date.now(),
      }))
      await device.sync.syncNow()

      expect(await device.db.getBookById(LARGE_ID)).toBeNull()
      const survivor = await device.db.getBookById(SMALL_ID)
      expect(survivor!.uri).toContain(LARGE_ID) // audio moved, never destroyed
      expect((await device.db.getClip(CLIP_B))!.source_id).toBe(SMALL_ID)
    })

    it('applies a plain book tombstone only to audio-less rows', async () => {
      const drive = new FakeDrive()
      const deviceWithAudio = createSyncHarness(drive)
      const deviceWithoutAudio = createSyncHarness(drive)

      await addBook(deviceWithAudio, SMALL_ID)
      await deviceWithAudio.sync.syncNow()
      await deviceWithoutAudio.sync.syncNow() // bootstraps the book (uri null)

      // Twin cleanup elsewhere tombstones the book without merged_into
      const file = drive.getFileByName(`book_${SMALL_ID}.json`)!
      await drive.updateFile(file.id, remoteBookJson({ id: SMALL_ID, deleted: true, updated_at: Date.now() }))
      await deviceWithAudio.sync.syncNow()
      await deviceWithoutAudio.sync.syncNow()

      // Audio holder keeps its per-device book; audio-less row is cleaned up
      expect(await deviceWithAudio.db.getBookById(SMALL_ID)).not.toBeNull()
      expect(await deviceWithoutAudio.db.getBookById(SMALL_ID)).toBeNull()
      expect(await deviceWithoutAudio.db.getManifestEntry('book', SMALL_ID)).toBeNull()
    })

    it('re-uploads children synced before the merge so all devices converge', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      // B's clip syncs under the losing id before the twin is ever seen
      await addBook(deviceB, LARGE_ID)
      await addClip(deviceB, CLIP_B, LARGE_ID)
      await deviceB.sync.syncNow()
      await deviceB.sync.syncNow() // consume upload echoes

      await addBook(deviceA, SMALL_ID)
      await deviceA.sync.syncNow() // pulls large → skip; pulls B's clip (dangles under large)
      expect((await deviceA.db.getClip(CLIP_B))!.source_id).toBe(LARGE_ID)
      expect(await deviceA.db.getAllClips()).toHaveLength(0) // invisible orphan

      await deviceB.sync.syncNow() // merge: re-key + retire + mass-bump the clip
      expect(drive.readJson(`clip_${CLIP_B}.json`).source_id).toBe(SMALL_ID)

      await deviceA.sync.syncNow() // pulls tombstone + the clip's re-upload

      expect((await deviceA.db.getClip(CLIP_B))!.source_id).toBe(SMALL_ID)
      expect(await deviceA.db.getAllClips()).toHaveLength(1) // visible again
      expect((await deviceB.db.getClip(CLIP_B))!.source_id).toBe(SMALL_ID)
      expect(await deviceB.db.getOutboxItems()).toEqual([])
    })

    it('converges a third device that bootstraps mid-merge', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceB, LARGE_ID)
      await addClip(deviceB, CLIP_B, LARGE_ID)
      await deviceB.sync.syncNow()
      await deviceB.sync.syncNow()

      await addBook(deviceA, SMALL_ID)
      await addClip(deviceA, CLIP_A, SMALL_ID)
      await deviceA.sync.syncNow() // twins now live on Drive

      // C bootstraps mid-merge: it sees both twins and merges on its own
      const deviceC = createSyncHarness(drive)
      const errorsC = trackSyncErrors(deviceC)
      await deviceC.sync.syncNow()
      expect(errorsC).toEqual([null])
      expect(await deviceC.db.getBookById(LARGE_ID)).toBeNull()
      expect(await deviceC.db.getBookById(SMALL_ID)).not.toBeNull()

      // Everyone settles
      await deviceB.sync.syncNow() // pulls the twin / tombstone → merges or adopts
      await deviceA.sync.syncNow()
      await deviceB.sync.syncNow()
      await deviceC.sync.syncNow()
      await deviceA.sync.syncNow()

      // One book + all clips everywhere, all under the surviving id
      for (const device of [deviceA, deviceB, deviceC]) {
        expect(await device.db.getBookById(LARGE_ID)).toBeNull()
        expect(await device.db.getBookById(SMALL_ID)).not.toBeNull()
        expect((await device.db.getClip(CLIP_A))!.source_id).toBe(SMALL_ID)
        expect((await device.db.getClip(CLIP_B))!.source_id).toBe(SMALL_ID)
        expect(await device.db.getAllClips()).toHaveLength(2)
        expect(await device.db.getOutboxItems()).toEqual([])
      }

      // Drive converged too: the loser is a tombstone, children name the survivor
      expect(drive.readJson(`book_${LARGE_ID}.json`).deleted).toBe(true)
      expect(drive.readJson(`book_${LARGE_ID}.json`).merged_into).toBe(SMALL_ID)
      expect(drive.readJson(`book_${SMALL_ID}.json`).deleted).toBeUndefined()
      expect(drive.readJson(`clip_${CLIP_B}.json`).source_id).toBe(SMALL_ID)
    })

    it('reattaches clips that bootstrap under a retired id', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      // B's clip is on Drive under the losing id
      await addBook(deviceB, LARGE_ID)
      await addClip(deviceB, CLIP_B, LARGE_ID)
      await deviceB.sync.syncNow()
      await deviceB.sync.syncNow()

      // A's twin triggers the merge on C; B (the clip's owner) stays offline,
      // so clip_{B}.json keeps naming the retired id
      await addBook(deviceA, SMALL_ID)
      await deviceA.sync.syncNow()
      const deviceC = createSyncHarness(drive)
      await deviceC.sync.syncNow() // merges + retires book_{large}
      expect(drive.readJson(`book_${LARGE_ID}.json`).merged_into).toBe(SMALL_ID)
      expect(drive.readJson(`clip_${CLIP_B}.json`).source_id).toBe(LARGE_ID)

      // A fresh device bootstraps: the clip arrives naming the retired id and
      // must still end up attached to the survivor
      const deviceD = createSyncHarness(drive)
      const errorsD = trackSyncErrors(deviceD)
      await deviceD.sync.syncNow()

      expect(errorsD).toEqual([null])
      expect(await deviceD.db.getBookById(SMALL_ID)).not.toBeNull()
      expect(await deviceD.db.getBookById(LARGE_ID)).toBeNull()
      expect((await deviceD.db.getClip(CLIP_B))!.source_id).toBe(SMALL_ID)
      expect(await deviceD.db.getAllClips()).toHaveLength(1) // visible, not orphaned
    })

    it('keeps clips made on both devices before the merge, under the surviving id', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceA, SMALL_ID)
      await addClip(deviceA, CLIP_A, SMALL_ID)
      await deviceA.sync.syncNow()

      await addBook(deviceB, LARGE_ID)
      await addClip(deviceB, CLIP_B, LARGE_ID) // clip made before B ever sees the twin
      await deviceB.sync.syncNow() // merge re-keys B's clip; push uploads it under the new id
      await deviceA.sync.syncNow() // A pulls B's clip

      expect(drive.readJson(`clip_${CLIP_B}.json`).source_id).toBe(SMALL_ID)
      expect((await deviceB.db.getClip(CLIP_A))!.source_id).toBe(SMALL_ID)
      expect((await deviceB.db.getClip(CLIP_B))!.source_id).toBe(SMALL_ID)
      expect((await deviceA.db.getClip(CLIP_A))!.source_id).toBe(SMALL_ID)
      expect((await deviceA.db.getClip(CLIP_B))!.source_id).toBe(SMALL_ID)

      // Both clips visible in the library join on both devices
      expect(await deviceA.db.getAllClips()).toHaveLength(2)
      expect(await deviceB.db.getAllClips()).toHaveLength(2)
    })
  })

  describe('duplicate remote files (twins)', () => {
    it('resolves live book twins to the smallest file id and tombstones the loser', async () => {
      const drive = new FakeDrive()
      // Two live copies of the same book JSON (create-new race, e.g. two
      // devices pushing before either saw the other's file)
      const winnerId = drive.putFile('books', `book_${BOOK_ID}.json`, remoteBookJson({ title: 'Copy One', updated_at: 5000 }))
      const loserId = drive.putFile('books', `book_${BOOK_ID}.json`, remoteBookJson({ title: 'Copy Two', updated_at: 6000 }))

      const deviceA = createSyncHarness(drive)
      const errorsA = trackSyncErrors(deviceA)
      await deviceA.sync.syncNow() // bootstrap sees both twins

      // No manifest → lexicographically smallest file id wins
      expect(errorsA).toEqual([null])
      expect((await deviceA.db.getBookById(BOOK_ID))!.title).toBe('Copy One')
      expect((await deviceA.db.getManifestEntry('book', BOOK_ID))!.remote_file_id).toBe(winnerId)

      // The loser was retired in place: full payload, plain tombstone
      const loser = JSON.parse(drive.files.get(loserId)!.content as string)
      expect(loser.deleted).toBe(true)
      expect(loser.merged_into).toBeUndefined()
      expect(loser.title).toBe('Copy Two')
      expect(JSON.parse(drive.files.get(winnerId)!.content as string).deleted).toBeUndefined()

      // Another device converges on the same winner (tombstoned twin skipped)
      const deviceB = createSyncHarness(drive)
      await deviceB.sync.syncNow()
      expect((await deviceB.db.getBookById(BOOK_ID))!.title).toBe('Copy One')
      expect((await deviceB.db.getManifestEntry('book', BOOK_ID))!.remote_file_id).toBe(winnerId)

      // No flapping: A's own tombstone echo is a no-op, nothing re-queues
      await deviceA.sync.syncNow()
      await deviceA.sync.syncNow()
      expect(await deviceA.db.getBookById(BOOK_ID)).not.toBeNull()
      expect(await deviceA.db.getOutboxItems()).toEqual([])
      expect(JSON.parse(drive.files.get(loserId)!.content as string).deleted).toBe(true)
      expect(JSON.parse(drive.files.get(winnerId)!.content as string).deleted).toBeUndefined()
    })

    it('prefers the manifest-tracked file over a smaller-id twin', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)

      await addBook(deviceA)
      await deviceA.sync.syncNow() // uploads — the manifest tracks this file
      await deviceA.sync.syncNow() // consume the upload echo
      const trackedId = drive.getFileByName(`book_${BOOK_ID}.json`)!.id

      // A twin with a smaller file id appears alongside an update to ours
      const twinId = drive.putFile('books', `book_${BOOK_ID}.json`, remoteBookJson({ title: 'Twin Copy', updated_at: 4000 }), 'a-smaller-id')
      expect(twinId < trackedId).toBe(true)
      await drive.updateFile(trackedId, remoteBookJson({ title: 'Tracked Copy', updated_at: Date.now() }))

      await deviceA.sync.syncNow() // both twins in one batch

      // The manifest-tracked file wins even though it is not the smallest id
      expect((await deviceA.db.getManifestEntry('book', BOOK_ID))!.remote_file_id).toBe(trackedId)
      expect((await deviceA.db.getBookById(BOOK_ID))!.title).toBe('Tracked Copy')
      expect(JSON.parse(drive.files.get(twinId)!.content as string).deleted).toBe(true)
      expect(JSON.parse(drive.files.get(trackedId)!.content as string).deleted).toBeUndefined()
    })
  })

  describe('clip audio versioning (M5)', () => {
    it('re-downloads audio when only the audio content changed (same JSON version)', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceA)
      await addClip(deviceA)
      await deviceA.sync.syncNow()
      await deviceA.sync.syncNow() // consume the upload echo
      await deviceB.sync.syncNow() // B bootstraps the clip

      const jsonId = drive.getFileByName(`clip_${CLIP_ID}.json`)!.id
      const audioId = drive.getFileByName(`clip_${CLIP_ID}.m4a`)!.id

      // A bounds edit updates in place: JSON first, the re-sliced audio after.
      // B syncs in between, so it applies the JSON but still holds old audio.
      await drive.updateFile(jsonId, remoteClipJson({ start: 20000, updated_at: Date.now() }))
      await deviceB.sync.syncNow()
      expect((await deviceB.db.getClip(CLIP_ID))!.start).toBe(20000)
      const versionBefore = (await deviceB.db.getManifestEntry('clip', CLIP_ID))!.remote_audio_version

      // The audio change arrives alone: same file id, same JSON version —
      // only the manifest's audio version reveals the stale content
      await drive.updateFile(audioId, new Uint8Array([9, 9, 9]))
      await deviceB.sync.syncNow()

      const manifest = await deviceB.db.getManifestEntry('clip', CLIP_ID)
      expect(manifest!.remote_audio_version).toBe(drive.md5(`clip_${CLIP_ID}.m4a`))
      expect(manifest!.remote_audio_version).not.toBe(versionBefore)
      // New bytes written over the clip's local audio file
      expect(RNFS.writeFile).toHaveBeenLastCalledWith(
        `/mock/documents/clips/${CLIP_ID}.m4a`,
        btoa(String.fromCharCode(9, 9, 9)),
        'base64',
      )
    })

    it('re-downloads audio grouped with a same-version JSON echo', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceA)
      await addClip(deviceA)
      await deviceA.sync.syncNow()
      await deviceA.sync.syncNow()
      await deviceB.sync.syncNow()

      const jsonFile = drive.getFileByName(`clip_${CLIP_ID}.json`)!
      const audioId = drive.getFileByName(`clip_${CLIP_ID}.m4a`)!.id

      // One feed batch: an identical JSON rewrite plus new audio content —
      // the JSON short-circuits as same-version, the audio must still land
      await drive.updateFile(jsonFile.id, jsonFile.content as string)
      await drive.updateFile(audioId, new Uint8Array([7, 7, 7]))
      await deviceB.sync.syncNow()

      const manifest = await deviceB.db.getManifestEntry('clip', CLIP_ID)
      expect(manifest!.remote_audio_version).toBe(drive.md5(`clip_${CLIP_ID}.m4a`))
      expect(RNFS.writeFile).toHaveBeenLastCalledWith(
        `/mock/documents/clips/${CLIP_ID}.m4a`,
        btoa(String.fromCharCode(7, 7, 7)),
        'base64',
      )
    })

    it('skips the audio download when the version matches (own upload echo)', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)

      await addBook(device)
      await addClip(device)
      await device.sync.syncNow() // uploads JSON + audio, records the version

      const audioId = drive.getFileByName(`clip_${CLIP_ID}.m4a`)!.id
      const downloads = jest.spyOn(drive, 'downloadFile')
      await device.sync.syncNow() // pulls its own echo

      expect(downloads).not.toHaveBeenCalledWith(audioId, true)
      expect(await device.db.getOutboxItems()).toEqual([])
    })

    it('receives resurrection healing: fresh audio id and version after a re-create', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceA)
      await addClip(deviceA)
      await deviceA.sync.syncNow()
      await deviceA.sync.syncNow()
      await deviceB.sync.syncNow()

      // A deletes (tombstone + audio hard-delete); B's newer edit un-deletes,
      // re-uploading the audio as a brand-new file (404 fallback path)
      await deleteClip(deviceA)
      await deviceA.sync.syncNow()
      await deviceB.db.updateClip(CLIP_ID, { note: 'Edited after delete' })
      const edited = await deviceB.db.getClip(CLIP_ID)
      await deviceB.db.queueChange('clip', CLIP_ID, 'upsert', edited!.updated_at)
      await deviceB.sync.syncNow()

      const newAudioId = drive.getFileByName(`clip_${CLIP_ID}.m4a`)!.id

      await deviceA.sync.syncNow() // A pulls the resurrection: new id + version

      expect((await deviceA.db.getClip(CLIP_ID))!.note).toBe('Edited after delete')
      const manifest = await deviceA.db.getManifestEntry('clip', CLIP_ID)
      expect(manifest!.remote_audio_file_id).toBe(newAudioId)
      expect(manifest!.remote_audio_version).toBe(drive.md5(`clip_${CLIP_ID}.m4a`))
    })
  })

  describe('404 fallback: create on dead remote id', () => {
    it('recreates the book JSON and heals the manifest when the remote was purged', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)
      const errors = trackSyncErrors(device)

      await addBook(device)
      await device.sync.syncNow()
      await device.sync.syncNow() // consume the upload echo
      const deadId = drive.getFileByName(`book_${BOOK_ID}.json`)!.id
      drive.removeFile(deadId) // user purged Drive out-of-band

      await device.db.updateBookMetadata(BOOK_ID, 'New Title', null)
      const edited = await device.db.getBookById(BOOK_ID)
      await device.db.queueChange('book', BOOK_ID, 'upsert', edited!.updated_at)
      await device.sync.syncNow()

      expect(errors[errors.length - 1]).toBeNull()
      const file = drive.getFileByName(`book_${BOOK_ID}.json`)!
      expect(file.id).not.toBe(deadId)
      expect(drive.readJson(`book_${BOOK_ID}.json`).title).toBe('New Title')
      expect((await device.db.getManifestEntry('book', BOOK_ID))!.remote_file_id).toBe(file.id)
      expect(await device.db.getOutboxItems(Number.MAX_SAFE_INTEGER)).toEqual([])
    })

    it('recreates the clip JSON while updating the audio in place', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)
      const errors = trackSyncErrors(device)

      await addBook(device)
      await addClip(device)
      await device.sync.syncNow()
      await device.sync.syncNow()
      const deadJsonId = drive.getFileByName(`clip_${CLIP_ID}.json`)!.id
      const audioId = drive.getFileByName(`clip_${CLIP_ID}.m4a`)!.id
      drive.removeFile(deadJsonId)

      await device.db.updateClip(CLIP_ID, { note: 'Edited' })
      const edited = await device.db.getClip(CLIP_ID)
      await device.db.queueChange('clip', CLIP_ID, 'upsert', edited!.updated_at)
      await device.sync.syncNow()

      expect(errors[errors.length - 1]).toBeNull()
      const jsonFile = drive.getFileByName(`clip_${CLIP_ID}.json`)!
      expect(jsonFile.id).not.toBe(deadJsonId)
      expect(drive.readJson(`clip_${CLIP_ID}.json`).note).toBe('Edited')
      expect(drive.getFileByName(`clip_${CLIP_ID}.m4a`)!.id).toBe(audioId) // untouched id
      const manifest = await device.db.getManifestEntry('clip', CLIP_ID)
      expect(manifest!.remote_file_id).toBe(jsonFile.id)
      expect(manifest!.remote_audio_file_id).toBe(audioId)
    })

    it('recreates the clip audio while updating the JSON in place', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)
      const errors = trackSyncErrors(device)

      await addBook(device)
      await addClip(device)
      await device.sync.syncNow()
      await device.sync.syncNow()
      const jsonId = drive.getFileByName(`clip_${CLIP_ID}.json`)!.id
      const deadAudioId = drive.getFileByName(`clip_${CLIP_ID}.m4a`)!.id
      drive.removeFile(deadAudioId)

      await device.db.updateClip(CLIP_ID, { note: 'Edited' })
      const edited = await device.db.getClip(CLIP_ID)
      await device.db.queueChange('clip', CLIP_ID, 'upsert', edited!.updated_at)
      await device.sync.syncNow()

      expect(errors[errors.length - 1]).toBeNull()
      const audioFile = drive.getFileByName(`clip_${CLIP_ID}.m4a`)!
      expect(audioFile.id).not.toBe(deadAudioId)
      expect(drive.getFileByName(`clip_${CLIP_ID}.json`)!.id).toBe(jsonId) // untouched id
      const manifest = await device.db.getManifestEntry('clip', CLIP_ID)
      expect(manifest!.remote_file_id).toBe(jsonId)
      expect(manifest!.remote_audio_file_id).toBe(audioFile.id)
    })

    it('recreates the session JSON when the remote was purged', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)
      const errors = trackSyncErrors(device)

      await addBook(device)
      const session = await device.db.createSession(BOOK_ID)
      await device.db.queueChange('session', session.id, 'upsert', session.updated_at)
      await device.sync.syncNow()
      await device.sync.syncNow()
      const deadId = drive.getFileByName(`session_${session.id}.json`)!.id
      drive.removeFile(deadId)

      await device.db.queueChange('session', session.id, 'upsert', session.updated_at)
      await device.sync.syncNow()

      expect(errors[errors.length - 1]).toBeNull()
      const file = drive.getFileByName(`session_${session.id}.json`)!
      expect(file.id).not.toBe(deadId)
      expect((await device.db.getManifestEntry('session', session.id))!.remote_file_id).toBe(file.id)
    })
  })

  describe('trashed remote files', () => {
    it('treats trashed feed changes as no-ops and recovers via full reconcile', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)
      const errors = trackSyncErrors(device)

      await addBook(device)
      await addClip(device)
      await device.sync.syncNow()
      await device.sync.syncNow() // consume the upload echoes
      const oldJsonId = drive.getFileByName(`clip_${CLIP_ID}.json`)!.id
      const oldAudioId = drive.getFileByName(`clip_${CLIP_ID}.m4a`)!.id

      // The user trashes the clip's files in Drive — the feed delivers them
      // as trashed changes, which must not delete or error anything locally
      drive.trashFile(oldJsonId)
      drive.trashFile(oldAudioId)
      await device.sync.syncNow()

      expect(errors[errors.length - 1]).toBeNull()
      expect(await device.db.getClip(CLIP_ID)).not.toBeNull()

      // Full reconcile (trash-filtered listing) sees the clip as local-only
      // and re-uploads it as fresh files, dropping the stale manifest ids
      await device.db.clearCheckpoint()
      await device.sync.syncNow()

      expect(errors[errors.length - 1]).toBeNull()
      const liveJson = [...drive.files.values()].filter(f => f.name === `clip_${CLIP_ID}.json` && !f.trashed)
      const liveAudio = [...drive.files.values()].filter(f => f.name === `clip_${CLIP_ID}.m4a` && !f.trashed)
      expect(liveJson).toHaveLength(1)
      expect(liveAudio).toHaveLength(1)
      expect(liveJson[0].id).not.toBe(oldJsonId)
      expect(liveAudio[0].id).not.toBe(oldAudioId)
      const manifest = await device.db.getManifestEntry('clip', CLIP_ID)
      expect(manifest!.remote_file_id).toBe(liveJson[0].id)
      expect(manifest!.remote_audio_file_id).toBe(liveAudio[0].id)
      expect(await device.db.getOutboxItems()).toEqual([])
    })
  })

  describe('bootstrap gating (M9)', () => {
    it('skips the push phase when the start token cannot be fetched', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      // The book already lives on Drive (uploaded by A)
      await addBook(deviceA)
      await deviceA.sync.syncNow()

      // B holds the same book and has it queued; its first sync fails to
      // initialize the pull — pushing blind would create a twin of A's file
      await addBook(deviceB)
      await deviceB.db.queueChange('book', BOOK_ID, 'upsert')
      drive.failNext('getStartPageToken', new Error('Network error'))
      await deviceB.sync.syncNow()

      expect([...drive.files.values()].filter(f => f.name === `book_${BOOK_ID}.json`)).toHaveLength(1)
      expect(await deviceB.db.getOutboxItems()).toHaveLength(1) // still queued

      // Next sync bootstraps and pushes normally — updating A's file in place
      await deviceB.sync.syncNow()
      expect([...drive.files.values()].filter(f => f.name === `book_${BOOK_ID}.json`)).toHaveLength(1)
      expect(await deviceB.db.getOutboxItems()).toEqual([])
    })

    it('skips the push phase when the initial full reconcile fails', async () => {
      const drive = new FakeDrive()
      const deviceA = createSyncHarness(drive)
      const deviceB = createSyncHarness(drive)

      await addBook(deviceA)
      await deviceA.sync.syncNow()

      await addBook(deviceB)
      await deviceB.db.queueChange('book', BOOK_ID, 'upsert')
      drive.failNext('listFiles', new Error('Network error'))
      await deviceB.sync.syncNow()

      expect([...drive.files.values()].filter(f => f.name === `book_${BOOK_ID}.json`)).toHaveLength(1)
      expect(await deviceB.db.getOutboxItems()).toHaveLength(1)

      await deviceB.sync.syncNow()
      expect([...drive.files.values()].filter(f => f.name === `book_${BOOK_ID}.json`)).toHaveLength(1)
      expect(await deviceB.db.getOutboxItems()).toEqual([])
    })
  })

  describe('pull quarantine (poison pill)', () => {
    it('quarantines a repeatedly failing entity so the token advances, then keeps retrying it', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)

      await addBook(device)
      await device.sync.syncNow() // bootstrap: uploads the book, establishes a token

      // Poison change: corrupt JSON that deterministically fails to parse
      drive.putFile('clips', `clip_${CLIP_ID}.json`, 'not json {')

      // Below the threshold every failure holds the token for re-delivery
      const tokenBefore = device.db.getCheckpoint().last_page_token
      for (let i = 0; i < 4; i++) {
        await device.sync.syncNow()
        expect(device.db.getCheckpoint().last_page_token).toBe(tokenBefore)
      }

      // The 5th consecutive failure quarantines the entity — the token advances
      await device.sync.syncNow()
      const tokenAfter = device.db.getCheckpoint().last_page_token
      expect(tokenAfter).not.toBe(tokenBefore)

      // The entity stays on the retry list: with no feed changes at all, the
      // next sync still attempts (and reports) the quarantined reconcile
      const errors = trackSyncErrors(device)
      await device.sync.syncNow()
      expect(errors[errors.length - 1]).not.toBeNull()
    })

    it('surfaces failing counts from both the push outbox and pull quarantine', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)

      await addBook(device)
      await device.sync.syncNow() // uploads the book, establishes a token

      // Pull side: poison JSON quarantines after 5 consecutive failures
      drive.putFile('clips', `clip_${CLIP_ID}.json`, 'not json {')
      for (let i = 0; i < 5; i++) {
        await device.sync.syncNow()
      }

      // Push side: a session upload failing 3 times counts as failing
      const session = await device.db.createSession(BOOK_ID)
      await device.db.queueChange('session', session.id, 'upsert', session.updated_at)
      for (let i = 0; i < 3; i++) {
        now += 6 * 60 * 60 * 1000 // jump past any backoff so the push is attempted
        drive.failNext('uploadFile', new Error('Network error'))
        await device.sync.syncNow()
      }

      expect(await device.sync.getFailingCount()).toBe(2)

      // The count rides on the emitted sync status
      const statuses: Array<{ isSyncing: boolean; failingCount: number }> = []
      device.sync.on('status', (status) => statuses.push(status))
      await device.sync.syncNow()
      expect(statuses[statuses.length - 1].failingCount).toBe(2)
    })

    it('clears quarantine when the entity finally reconciles', async () => {
      const drive = new FakeDrive()
      const device = createSyncHarness(drive)

      await addBook(device)
      await device.sync.syncNow()

      const poisonId = drive.putFile('clips', `clip_${CLIP_ID}.json`, 'not json {')
      for (let i = 0; i < 5; i++) {
        await device.sync.syncNow() // 5 consecutive failures → quarantined
      }

      // The owning device repairs the clip: fixed JSON plus its audio file
      drive.putFile('clips', `clip_${CLIP_ID}.m4a`, new Uint8Array([1, 2, 3]))
      await drive.updateFile(poisonId, remoteClipJson())

      const errors = trackSyncErrors(device)
      await device.sync.syncNow() // the feed delivers the fix; reconcile succeeds

      expect(errors).toEqual([null])
      expect(await device.db.getClip(CLIP_ID)).not.toBeNull()

      // Nothing left on the retry list — subsequent syncs stay clean
      await device.sync.syncNow()
      expect(errors).toEqual([null, null])
    })
  })

  it('re-delivers a failed remote change by holding the page token', async () => {
    const drive = new FakeDrive()
    const deviceA = createSyncHarness(drive)
    const deviceB = createSyncHarness(drive)

    await addBook(deviceA)
    await deviceA.sync.syncNow()
    await deviceB.sync.syncNow()

    await deviceA.db.updateBookMetadata(BOOK_ID, 'New Title', null)
    const edited = await deviceA.db.getBookById(BOOK_ID)
    await deviceA.db.queueChange('book', BOOK_ID, 'upsert', edited!.updated_at)
    await deviceA.sync.syncNow()

    // First pull attempt on B fails to download — token must not advance
    const tokenBefore = deviceB.db.getCheckpoint().last_page_token
    drive.failNext('downloadFile', new Error('Network error'))
    await deviceB.sync.syncNow()

    expect(deviceB.db.getCheckpoint().last_page_token).toBe(tokenBefore)
    expect((await deviceB.db.getBookById(BOOK_ID))!.title).toBe('Test Title')

    // Next sync re-delivers the change and applies it
    await deviceB.sync.syncNow()
    expect((await deviceB.db.getBookById(BOOK_ID))!.title).toBe('New Title')
  })
})
