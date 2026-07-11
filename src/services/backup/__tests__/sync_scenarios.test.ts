/**
 * Sync engine scenarios
 *
 * End-to-end sync flows through the real BackupSyncService, real
 * DatabaseService (real SQLite) and the scripted FakeDrive.
 */

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

    const items = await device.db.getOutboxItems()
    expect(items).toHaveLength(1)
    expect(items[0].attempts).toBe(1)
    expect(items[0].last_error).toBe('Network error')

    await device.sync.syncNow()

    expect(await device.db.getOutboxItems()).toEqual([])
    expect(drive.getFileByName(`book_${BOOK_ID}.json`)).toBeDefined()
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
