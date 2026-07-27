import { createShareClip, shareFilename, ShareClipDeps } from '../share_clip'
import { createMockClip, createMockState, createMockGet } from './helpers'


// -- Helpers ------------------------------------------------------------------

function createDeps(clipOverrides: Parameters<typeof createMockClip>[0] = {}) {
  const clip = createMockClip(clipOverrides)
  const state = createMockState({ clips: { [clip.id]: clip } })
  const sharing = { shareClipFile: jest.fn(async () => {}) }

  const deps: ShareClipDeps = {
    sharing: sharing as any,
    get: createMockGet(state),
  }
  return { deps, sharing, clip }
}


// -- Tests --------------------------------------------------------------------

describe('createShareClip', () => {
  it('shares the clip audio file with the note as title', async () => {
    const { deps, sharing } = createDeps({ note: 'A great moment' })

    await createShareClip(deps)('clip-1')

    expect(sharing.shareClipFile).toHaveBeenCalledWith(
      'file:///clips/clip-1.mp3', 'A great moment', expect.any(String),
    )
  })

  // The title fallback chain: note || file_name || source_title || 'Clip'
  it('falls back to the source file name when there is no note', async () => {
    const { deps, sharing } = createDeps({ note: '', file_name: 'Book.mp3' })

    await createShareClip(deps)('clip-1')

    expect(sharing.shareClipFile).toHaveBeenCalledWith(expect.any(String), 'Book.mp3', expect.any(String))
  })

  it('falls back to the source_title snapshot when the book row is gone', async () => {
    // Orphaned clip: no note, no joined file_name, only the snapshot survives
    const { deps, sharing } = createDeps({ note: '', file_name: null, source_title: 'Snapshot Title' })

    await createShareClip(deps)('clip-1')

    expect(sharing.shareClipFile).toHaveBeenCalledWith(expect.any(String), 'Snapshot Title', expect.any(String))
  })

  it('uses a generic title when nothing identifies the clip', async () => {
    const { deps, sharing } = createDeps({ note: '', file_name: null, source_title: null, file_title: null })

    await createShareClip(deps)('clip-1')

    expect(sharing.shareClipFile).toHaveBeenCalledWith(expect.any(String), 'Clip', expect.any(String))
  })

  it('passes a friendly filename built from the book title', async () => {
    const { deps, sharing } = createDeps({ file_title: 'Project Hail Mary' })

    await createShareClip(deps)('clip-1')

    expect(sharing.shareClipFile).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), 'Clip from Project Hail Mary clip-1.mp3',
    )
  })

  it('throws when the clip does not exist', async () => {
    const { deps, sharing } = createDeps()

    await expect(createShareClip(deps)('no-such-clip')).rejects.toThrow('Clip not found')
    expect(sharing.shareClipFile).not.toHaveBeenCalled()
  })
})

describe('shareFilename', () => {
  const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

  it('builds "Clip from <title> <uuid8>.<ext>"', () => {
    expect(shareFilename(uuid, 'file:///clips/x.m4a', 'Project Hail Mary'))
      .toBe('Clip from Project Hail Mary a1b2c3d4.m4a')
  })

  it('falls back to "Clip <uuid8>" without a book title', () => {
    expect(shareFilename(uuid, 'file:///clips/x.m4a', null))
      .toBe('Clip a1b2c3d4.m4a')
  })

  it('strips filesystem-hostile characters from the title', () => {
    expect(shareFilename(uuid, 'file:///clips/x.m4a', 'A/B: "C"?<D>|E*\\F'))
      .toBe('Clip from A B C D E F a1b2c3d4.m4a')
  })

  it('caps overlong titles', () => {
    const filename = shareFilename(uuid, 'file:///clips/x.m4a', 'long title '.repeat(30))
    expect(filename.length).toBeLessThanOrEqual(70 + ' a1b2c3d4.m4a'.length)
    expect(filename.endsWith(' a1b2c3d4.m4a')).toBe(true)
  })

  it('defaults the extension to m4a when the uri has none', () => {
    expect(shareFilename(uuid, 'file:///clips/noext', 'Title'))
      .toBe('Clip from Title a1b2c3d4.m4a')
  })
})
