import { createCleanupOrphanedFiles, CleanupOrphanedFilesDeps } from '../cleanup_orphaned_files'

jest.mock('../../utils', () => ({
  createLogger: () => () => {},
}))


// -- Helpers ------------------------------------------------------------------

const HOUR = 60 * 60 * 1000

// CLIPS_DIR resolves to this under the mocked RNFS.DocumentDirectoryPath
const CLIPS_DIR = '/mock/documents/clips'

function createDeps(opts: {
  known?: string[]
  audioFiles?: string[]
  clipFiles?: string[]
  mtimes?: Record<string, number | null>
} = {}) {
  const deps: CleanupOrphanedFilesDeps = {
    db: {
      getAllFileUris: jest.fn(async () => new Set(opts.known ?? [])),
    } as any,
    files: {
      audioDirectoryPath: '/audio',
      listFiles: jest.fn(async (dir: string) => (
        dir === CLIPS_DIR ? (opts.clipFiles ?? []) : (opts.audioFiles ?? [])
      )),
      getModificationTime: jest.fn(async (uri: string) => opts.mtimes?.[uri] ?? null),
      deleteFile: jest.fn(async () => {}),
    } as any,
  }
  return deps
}


// -- Tests --------------------------------------------------------------------

describe('createCleanupOrphanedFiles', () => {

  it('deletes orphans older than the grace period', async () => {
    const deps = createDeps({
      audioFiles: ['file:///audio/old-orphan.mp3'],
      mtimes: { 'file:///audio/old-orphan.mp3': Date.now() - 2 * HOUR },
    })
    const cleanup = createCleanupOrphanedFiles(deps)

    await cleanup()

    expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/old-orphan.mp3')
  })

  it('skips orphans modified within the grace period', async () => {
    // A fresh file may belong to in-flight work: clip audio written by sync
    // before its DB row, or a slice not yet committed
    const deps = createDeps({
      audioFiles: ['file:///audio/fresh.mp3'],
      clipFiles: ['file:///mock/documents/clips/fresh.m4a'],
      mtimes: {
        'file:///audio/fresh.mp3': Date.now() - 5 * 60 * 1000,
        'file:///mock/documents/clips/fresh.m4a': Date.now(),
      },
    })
    const cleanup = createCleanupOrphanedFiles(deps)

    await cleanup()

    expect(deps.files.deleteFile).not.toHaveBeenCalled()
  })

  it('skips orphans whose modification time is unavailable', async () => {
    const deps = createDeps({
      audioFiles: ['file:///audio/unstattable.mp3'],
      mtimes: { 'file:///audio/unstattable.mp3': null },
    })
    const cleanup = createCleanupOrphanedFiles(deps)

    await cleanup()

    expect(deps.files.deleteFile).not.toHaveBeenCalled()
  })

  it('never deletes files with DB rows, regardless of age', async () => {
    const deps = createDeps({
      known: ['file:///audio/known.mp3'],
      audioFiles: ['file:///audio/known.mp3'],
      mtimes: { 'file:///audio/known.mp3': Date.now() - 10 * HOUR },
    })
    const cleanup = createCleanupOrphanedFiles(deps)

    await cleanup()

    expect(deps.files.deleteFile).not.toHaveBeenCalled()
  })
})
