import RNFS from 'react-native-fs'
import { ARTWORK_DIR, ArtworkStore, artworkFilename, parseArtwork } from '../artwork'
import { fnv1a } from '../../../utils'

/**
 * Tests for ArtworkStore: book covers as files named <bookId>.<hash4>.<ext>
 * (see docs/2026-09-28-artwork-as-files.md).
 */

// In-memory filesystem: path -> base64 content (dirs implied by prefixes)
jest.mock('react-native-fs', () => ({
  __files: new Map<string, string>(),
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(),
  mkdir: jest.fn(async () => {}),
  writeFile: jest.fn(),
  readFile: jest.fn(),
  moveFile: jest.fn(),
  readDir: jest.fn(),
  unlink: jest.fn(),
}))

const files = (RNFS as any).__files as Map<string, string>
const mocked = RNFS as jest.Mocked<typeof RNFS>

const JPEG_BASE64 = '/9j/4AAQSkZJRg=='
const JPEG = `data:image/jpeg;base64,${JPEG_BASE64}`
const OTHER_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgAB'
const PNG = 'data:image/png;base64,iVBORw0KGgo='

const hash4 = (base64: string) => fnv1a(base64).toString(16).padStart(8, '0').slice(0, 4)

beforeEach(() => {
  files.clear()
  jest.clearAllMocks()
  mocked.exists.mockImplementation(async (path: string) =>
    files.has(path) || [...files.keys()].some(p => p.startsWith(`${path}/`)))
  mocked.writeFile.mockImplementation(async (path: string, content: string) => { files.set(path, content) })
  mocked.readFile.mockImplementation(async (path: string) => files.get(path)!)
  mocked.moveFile.mockImplementation(async (src: string, dst: string) => {
    files.set(dst, files.get(src)!)
    files.delete(src)
  })
  mocked.readDir.mockImplementation(async (dir: string) =>
    [...files.keys()]
      .filter(path => path.startsWith(`${dir}/`))
      .map(path => ({ path, name: path.slice(dir.length + 1) }) as any))
  // unlink is recursive on directories, like RNFS
  mocked.unlink.mockImplementation(async (path: string) => {
    for (const p of [...files.keys()]) if (p === path || p.startsWith(`${path}/`)) files.delete(p)
  })
})

const stored = () => [...files.keys()].sort()

describe('parseArtwork', () => {
  it('splits payload and maps the image type to an extension', () => {
    expect(parseArtwork(JPEG)).toEqual({ base64: JPEG_BASE64, ext: 'jpg' })
    expect(parseArtwork(PNG)).toEqual({ base64: 'iVBORw0KGgo=', ext: 'png' })
  })

  it('tolerates wrapped base64 (Base64.DEFAULT line breaks)', () => {
    expect(parseArtwork('data:image/jpeg;base64,/9j/\n4AAQ')).not.toBeNull()
  })

  it('rejects anything that is not a non-empty base64 image data URI', () => {
    expect(parseArtwork('')).toBeNull()
    expect(parseArtwork('file:///cover.jpg')).toBeNull()
    expect(parseArtwork('data:text/plain;base64,aGVsbG8=')).toBeNull()
    expect(parseArtwork('data:image/jpeg,rawbytes')).toBeNull()        // not base64
    expect(parseArtwork('data:image/jpeg;base64,')).toBeNull()         // empty payload
    expect(parseArtwork('data:image/jpeg;base64,not base64!')).toBeNull()
  })
})

describe('artworkFilename', () => {
  it('is <bookId>.<hash4>.<ext>, hash4 from fnv1a over the base64', () => {
    const name = artworkFilename('book-1', parseArtwork(JPEG)!)
    expect(name).toBe(`book-1.${hash4(JPEG_BASE64)}.jpg`)
    expect(name).toMatch(/^book-1\.[0-9a-f]{4}\.jpg$/)
  })

  it('changes with the content, not with the book alone', () => {
    const a = artworkFilename('book-1', parseArtwork(JPEG)!)
    const b = artworkFilename('book-1', parseArtwork(OTHER_JPEG)!)
    expect(a).not.toBe(b)
  })
})

describe('ArtworkStore', () => {
  const store = new ArtworkStore()

  it('lives in <documents>/artwork', () => {
    expect(ARTWORK_DIR).toBe('/docs/artwork')
    expect(store.path('b.abcd.jpg')).toBe('/docs/artwork/b.abcd.jpg')
    expect(store.uri('b.abcd.jpg')).toBe('file:///docs/artwork/b.abcd.jpg')
  })

  it('writes the decoded payload and returns the filename', async () => {
    const name = await store.write('book-1', JPEG)

    expect(name).toBe(`book-1.${hash4(JPEG_BASE64)}.jpg`)
    expect(files.get(store.path(name!))).toBe(JPEG_BASE64)
    expect(mocked.writeFile).toHaveBeenCalledWith(expect.any(String), JPEG_BASE64, 'base64')
  })

  it('writes through a temp file and renames it (never half-written)', async () => {
    const name = await store.write('book-1', JPEG)
    const path = store.path(name!)

    expect(mocked.writeFile).toHaveBeenCalledWith(`${path}.tmp`, JPEG_BASE64, 'base64')
    expect(mocked.moveFile).toHaveBeenCalledWith(`${path}.tmp`, path)
    expect(stored()).toEqual([path])
  })

  it('reuses an existing file for the same book and image', async () => {
    const first = await store.write('book-1', JPEG)
    const second = await store.write('book-1', JPEG)

    expect(second).toBe(first)
    expect(mocked.writeFile).toHaveBeenCalledTimes(1)
  })

  it('keeps the image type in the extension', async () => {
    expect(await store.write('book-1', PNG)).toMatch(/\.png$/)
  })

  it('returns null and writes nothing for unrecognized input', async () => {
    expect(await store.write('book-1', 'data:text/plain;base64,aGVsbG8=')).toBeNull()
    expect(await store.write('book-1', 'garbage')).toBeNull()
    expect(mocked.writeFile).not.toHaveBeenCalled()
  })

  it('propagates filesystem errors', async () => {
    mocked.writeFile.mockRejectedValue(new Error('ENOSPC'))
    await expect(store.write('book-1', JPEG)).rejects.toThrow('ENOSPC')
  })

  it('reads a cover back as a data URI', async () => {
    const jpg = await store.write('book-1', JPEG)
    const png = await store.write('book-2', PNG)

    expect(await store.readDataUri(jpg!)).toBe(JPEG)
    expect(await store.readDataUri(png!)).toBe(PNG)
  })

  it('reads a missing file as null', async () => {
    expect(await store.readDataUri('book-1.abcd.jpg')).toBeNull()
  })

  it('replace = write new, then remove old', async () => {
    const old = await store.write('book-1', JPEG)
    const next = await store.write('book-1', OTHER_JPEG)
    await store.remove(old!)

    expect(stored()).toEqual([store.path(next!)])
  })

  it('removes missing files without complaint', async () => {
    await expect(store.remove('book-1.abcd.jpg')).resolves.toBeUndefined()
  })

  it('sweeps unreferenced files and stale temp files', async () => {
    const kept = await store.write('book-1', JPEG)
    const orphan = await store.write('book-2', PNG)
    files.set(`${store.path('book-3.abcd.jpg')}.tmp`, 'half')

    const removed = await store.sweep([kept!])

    expect(removed).toBe(2)
    expect(stored()).toEqual([store.path(kept!)])
    expect(files.has(store.path(orphan!))).toBe(false)
  })

  it('sweeps nothing when the directory does not exist', async () => {
    expect(await store.sweep([])).toBe(0)
    expect(mocked.readDir).not.toHaveBeenCalled()
  })

  it('clears the whole directory', async () => {
    await store.write('book-1', JPEG)
    await store.write('book-2', PNG)
    files.set('/docs/audio/keep.mp3', 'audio')

    await store.clear()

    expect(stored()).toEqual(['/docs/audio/keep.mp3'])
  })
})
