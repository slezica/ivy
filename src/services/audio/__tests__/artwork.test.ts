import RNFS from 'react-native-fs'
import { ARTWORK_CACHE_DIR, artworkFileUri } from '../artwork'

/**
 * Tests for artworkFileUri(): media-session artwork is written to a cache file
 * so the session carries a short file:// URI instead of a data URI (see
 * docs/2026-09-28-systemui-artwork-crash.md).
 */

// In-memory filesystem: path -> base64 content
jest.mock('react-native-fs', () => ({
  __files: new Map<string, string>(),
  CachesDirectoryPath: '/cache',
  exists: jest.fn(),
  mkdir: jest.fn(async () => {}),
  writeFile: jest.fn(),
  moveFile: jest.fn(),
  readDir: jest.fn(),
  unlink: jest.fn(),
}))

const files = (RNFS as any).__files as Map<string, string>
const mocked = RNFS as jest.Mocked<typeof RNFS>

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
const OTHER_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgAB'
const PNG = 'data:image/png;base64,iVBORw0KGgo='

beforeEach(() => {
  files.clear()
  jest.clearAllMocks()
  mocked.exists.mockImplementation(async (path: string) => files.has(path))
  mocked.writeFile.mockImplementation(async (path: string, content: string) => { files.set(path, content) })
  mocked.moveFile.mockImplementation(async (src: string, dst: string) => {
    files.set(dst, files.get(src)!)
    files.delete(src)
  })
  mocked.readDir.mockImplementation(async (dir: string) =>
    [...files.keys()]
      .filter(path => path.startsWith(`${dir}/`))
      .map(path => ({ path, name: path.slice(dir.length + 1) }) as any))
  mocked.unlink.mockImplementation(async (path: string) => { files.delete(path) })
})

const cached = () => [...files.keys()].sort()

describe('artworkFileUri', () => {
  it('writes a data URI to a cache file and returns its file:// URI', async () => {
    const uri = await artworkFileUri(JPEG)

    expect(uri).toMatch(new RegExp(`^file://${ARTWORK_CACHE_DIR}/[0-9a-f]{8}-\\d+\\.jpg$`))
    const path = uri!.slice('file://'.length)
    expect(files.get(path)).toBe('/9j/4AAQSkZJRg==')  // raw base64, header stripped
  })

  it('writes through a temp file and renames it (never half-written)', async () => {
    const uri = await artworkFileUri(JPEG)
    const path = uri!.slice('file://'.length)

    expect(mocked.writeFile).toHaveBeenCalledWith(`${path}.tmp`, expect.any(String), 'base64')
    expect(mocked.moveFile).toHaveBeenCalledWith(`${path}.tmp`, path)
  })

  it('reuses the file for the same image', async () => {
    const first = await artworkFileUri(JPEG)
    const second = await artworkFileUri(JPEG)

    expect(second).toBe(first)
    expect(mocked.writeFile).toHaveBeenCalledTimes(1)
  })

  it('gives changed artwork a new file and prunes the old one', async () => {
    const first = await artworkFileUri(JPEG)
    const second = await artworkFileUri(OTHER_JPEG)

    expect(second).not.toBe(first)
    expect(cached()).toEqual([second!.slice('file://'.length)])
  })

  it('keeps the image type in the extension', async () => {
    expect(await artworkFileUri(PNG)).toMatch(/\.png$/)
  })

  it('returns null for missing or unrecognized artwork', async () => {
    expect(await artworkFileUri(null)).toBeNull()
    expect(await artworkFileUri(undefined)).toBeNull()
    expect(await artworkFileUri('')).toBeNull()
    expect(await artworkFileUri('data:text/plain,hello')).toBeNull()
    expect(mocked.writeFile).not.toHaveBeenCalled()
  })

  it('passes non-data URIs through untouched', async () => {
    expect(await artworkFileUri('file:///somewhere/cover.jpg')).toBe('file:///somewhere/cover.jpg')
    expect(mocked.writeFile).not.toHaveBeenCalled()
  })

  it('propagates write failures (the player decides the fallback)', async () => {
    mocked.writeFile.mockRejectedValue(new Error('ENOSPC'))

    await expect(artworkFileUri(JPEG)).rejects.toThrow('ENOSPC')
  })
})
