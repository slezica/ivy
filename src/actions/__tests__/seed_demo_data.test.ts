import RNFS from 'react-native-fs'
import { createSeedDemoData, DEMO_DIR } from '../seed_demo_data'
import { createMockState, createImmerSet, createMockDb, createMockFiles } from './helpers'


// -- Helpers ------------------------------------------------------------------

const SEED = {
  books: [
    { id: 'b-hero', name: 'hero.mp3', title: 'Hero', artist: 'Author A', duration: 1000000, position: 500000, audio: 'hero.mp3', artwork: 'b-hero.png' },
    { id: 'b-two', name: 'two.mp3', title: 'Two', artist: 'Author B', duration: 2000000, position: 0, audio: 'short.mp3' },
    { id: 'b-gone', name: 'gone.mp3', title: 'Gone', artist: 'Author C', duration: 3000000, position: 3000000, archived: true },
  ],
  clips: [
    { id: 'c-1', book: 'b-hero', start: 1000, duration: 2000, note: 'a note', transcription: 'spoken words', audio: 'clip.mp3', daysAgo: 2 },
  ],
  sessions: [
    { book: 'b-hero', daysAgo: 1, startHour: 8.5, minutes: 30 },
  ],
}

function createDeps() {
  const state = createMockState() as any
  state.settings = { sync_enabled: true, transcription_enabled: true }

  const db = createMockDb({
    clearAllData: jest.fn(),
    restoreBookFromBackup: jest.fn(async () => {}),
    restoreClipFromBackup: jest.fn(async () => {}),
    restoreSessionFromBackup: jest.fn(async () => {}),
    setBookUri: jest.fn(async () => {}),
    setSettings: jest.fn(async () => {}),
  })
  const files = createMockFiles()
  const set = createImmerSet(state)

  return { state, deps: { db, files, set } }
}

function mockBundle(seed: object | null) {
  ;(RNFS.exists as jest.Mock).mockImplementation(async (path: string) => seed !== null && path === `${DEMO_DIR}/seed.json`)
  ;(RNFS.readFile as jest.Mock).mockImplementation(async (path: string, encoding: string) => {
    if (path.endsWith('seed.json')) return JSON.stringify(seed)
    if (encoding === 'base64') return 'UE5HYnl0ZXM='
    return ''
  })
}


// -- Tests --------------------------------------------------------------------

describe('createSeedDemoData', () => {

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('does nothing when no seed bundle is present', async () => {
    const { deps } = createDeps()
    mockBundle(null)

    const seeded = await createSeedDemoData(deps)()

    expect(seeded).toBe(false)
    expect(deps.db.clearAllData).not.toHaveBeenCalled()
  })

  it('wipes the database and seeds books with descending updated_at', async () => {
    const { deps } = createDeps()
    mockBundle(SEED)

    const seeded = await createSeedDemoData(deps)()

    expect(seeded).toBe(true)
    expect(deps.db.clearAllData).toHaveBeenCalled()
    expect(deps.db.restoreBookFromBackup).toHaveBeenCalledTimes(3)

    const calls = (deps.db.restoreBookFromBackup as jest.Mock).mock.calls
    expect(calls.map((c: any[]) => c[0])).toEqual(['b-hero', 'b-two', 'b-gone'])
    const timestamps = calls.map((c: any[]) => c[4])
    expect(timestamps[0]).toBeGreaterThan(timestamps[1])
    expect(timestamps[1]).toBeGreaterThan(timestamps[2])
  })

  it('copies audio and sets uri for active books only', async () => {
    const { deps } = createDeps()
    mockBundle(SEED)

    await createSeedDemoData(deps)()

    expect(RNFS.copyFile).toHaveBeenCalledWith(`${DEMO_DIR}/hero.mp3`, '/audio/b-hero.mp3')
    expect(deps.db.setBookUri).toHaveBeenCalledWith('b-hero', 'file:///audio/b-hero.mp3')
    expect(deps.db.setBookUri).toHaveBeenCalledWith('b-two', 'file:///audio/b-two.mp3')
    expect(deps.db.setBookUri).not.toHaveBeenCalledWith('b-gone', expect.anything())
  })

  it('embeds artwork as a base64 data URI', async () => {
    const { deps } = createDeps()
    mockBundle(SEED)

    await createSeedDemoData(deps)()

    const heroCall = (deps.db.restoreBookFromBackup as jest.Mock).mock.calls[0]
    expect(heroCall[8]).toBe('data:image/png;base64,UE5HYnl0ZXM=')
  })

  it('seeds clips with source snapshots and transcription', async () => {
    const { deps } = createDeps()
    mockBundle(SEED)

    await createSeedDemoData(deps)()

    expect(deps.db.restoreClipFromBackup).toHaveBeenCalledWith(
      'c-1', 'b-hero', 'file:///mock/documents/clips/c-1.mp3', 1000, 2000,
      'a note', 'spoken words',
      expect.any(Number), expect.any(Number), null,
      'Hero', 'Author A',
    )
  })

  it('seeds sessions at the specified day and duration', async () => {
    const { deps } = createDeps()
    mockBundle(SEED)

    await createSeedDemoData(deps)()

    const [id, bookId, startedAt, endedAt] = (deps.db.restoreSessionFromBackup as jest.Mock).mock.calls[0]
    expect(id).toBe('demo-session-0')
    expect(bookId).toBe('b-hero')
    expect(endedAt - startedAt).toBe(30 * 60_000)
    expect(startedAt).toBeLessThan(Date.now())
  })

  it('disables sync and transcription, then consumes the bundle', async () => {
    const { state, deps } = createDeps()
    mockBundle(SEED)

    await createSeedDemoData(deps)()

    const settings = { sync_enabled: false, transcription_enabled: false }
    expect(deps.db.setSettings).toHaveBeenCalledWith(settings)
    expect(state.settings).toEqual(settings)
    expect(RNFS.unlink).toHaveBeenCalledWith(DEMO_DIR)
  })
})
