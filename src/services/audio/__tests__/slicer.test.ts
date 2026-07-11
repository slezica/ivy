import RNFS from 'react-native-fs'
import { AudioSlicerService } from '../slicer'

/**
 * Tests for AudioSlicerService.move().
 *
 * Bug M17: the destination was unlinked before the move, so a failed move
 * left the DB pointing at a nonexistent file — losing the clip's only audio.
 * move() now keeps the old destination as a `.bak` until the move succeeds.
 */

// Stateful in-memory filesystem so move/exists/unlink interact realistically
jest.mock('react-native-fs', () => ({
  __files: new Set<string>(),
  CachesDirectoryPath: '/cache',
  exists: jest.fn(),
  unlink: jest.fn(),
  moveFile: jest.fn(),
}))

const fs = (RNFS as any).__files as Set<string>

const baseExists = async (path: string) => fs.has(path)
const baseUnlink = async (path: string) => {
  if (!fs.has(path)) throw new Error(`ENOENT: ${path}`)
  fs.delete(path)
}
const baseMoveFile = async (src: string, dst: string) => {
  if (!fs.has(src)) throw new Error(`ENOENT: ${src}`)
  fs.delete(src)
  fs.add(dst)
}

describe('AudioSlicerService.move', () => {
  const SRC = '/cache/slice-temp.m4a'
  const DST = '/clips/clip-1.m4a'
  const BAK = '/clips/clip-1.m4a.bak'

  beforeEach(() => {
    fs.clear()
    ;(RNFS.exists as jest.Mock).mockReset().mockImplementation(baseExists)
    ;(RNFS.unlink as jest.Mock).mockReset().mockImplementation(baseUnlink)
    ;(RNFS.moveFile as jest.Mock).mockReset().mockImplementation(baseMoveFile)
  })

  it('replaces an existing destination and removes the backup on success', async () => {
    fs.add(SRC)
    fs.add(DST)

    const slicer = new AudioSlicerService()
    await slicer.move(SRC, DST)

    expect(fs.has(DST)).toBe(true)
    expect(fs.has(SRC)).toBe(false)
    expect(fs.has(BAK)).toBe(false)
  })

  it('moves normally when the destination does not exist', async () => {
    fs.add(SRC)

    const slicer = new AudioSlicerService()
    await slicer.move(SRC, DST)

    expect(fs.has(DST)).toBe(true)
    expect(fs.has(BAK)).toBe(false)
  })

  it('restores the old destination and re-throws when the move fails', async () => {
    fs.add(SRC)
    fs.add(DST)

    // Fail only the src → dst move; backup and restore moves still work
    ;(RNFS.moveFile as jest.Mock).mockImplementation(async (src: string, dst: string) => {
      if (src === SRC) throw new Error('disk full')
      return baseMoveFile(src, dst)
    })

    const slicer = new AudioSlicerService()
    await expect(slicer.move(SRC, DST)).rejects.toThrow('disk full')

    // Old audio is back at the destination, backup consumed
    expect(fs.has(DST)).toBe(true)
    expect(fs.has(BAK)).toBe(false)
  })

  it('re-throws without a backup when the destination did not exist', async () => {
    fs.add(SRC)

    ;(RNFS.moveFile as jest.Mock).mockImplementation(async () => {
      throw new Error('disk full')
    })

    const slicer = new AudioSlicerService()
    await expect(slicer.move(SRC, DST)).rejects.toThrow('disk full')

    expect(fs.has(BAK)).toBe(false)
  })

  it('replaces a stale backup left over from a previous run', async () => {
    fs.add(SRC)
    fs.add(DST)
    fs.add(BAK)

    const slicer = new AudioSlicerService()
    await slicer.move(SRC, DST)

    expect(fs.has(DST)).toBe(true)
    expect(fs.has(BAK)).toBe(false)
  })

  it('still succeeds when backup cleanup fails', async () => {
    fs.add(SRC)
    fs.add(DST)

    ;(RNFS.unlink as jest.Mock).mockImplementation(async (path: string) => {
      if (path === BAK) throw new Error('busy')
      return baseUnlink(path)
    })

    const slicer = new AudioSlicerService()
    await expect(slicer.move(SRC, DST)).resolves.toBeUndefined()

    expect(fs.has(DST)).toBe(true)
  })
})
