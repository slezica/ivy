import { createShareClip, ShareClipDeps } from '../share_clip'
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

    expect(sharing.shareClipFile).toHaveBeenCalledWith('file:///clips/clip-1.mp3', 'A great moment')
  })

  // The title fallback chain: note || file_name || source_title || 'Clip'
  it('falls back to the source file name when there is no note', async () => {
    const { deps, sharing } = createDeps({ note: '', file_name: 'Book.mp3' })

    await createShareClip(deps)('clip-1')

    expect(sharing.shareClipFile).toHaveBeenCalledWith(expect.any(String), 'Book.mp3')
  })

  it('falls back to the source_title snapshot when the book row is gone', async () => {
    // Orphaned clip: no note, no joined file_name, only the snapshot survives
    const { deps, sharing } = createDeps({ note: '', file_name: null, source_title: 'Snapshot Title' })

    await createShareClip(deps)('clip-1')

    expect(sharing.shareClipFile).toHaveBeenCalledWith(expect.any(String), 'Snapshot Title')
  })

  it('uses a generic title when nothing identifies the clip', async () => {
    const { deps, sharing } = createDeps({ note: '', file_name: null, source_title: null })

    await createShareClip(deps)('clip-1')

    expect(sharing.shareClipFile).toHaveBeenCalledWith(expect.any(String), 'Clip')
  })

  it('throws when the clip does not exist', async () => {
    const { deps, sharing } = createDeps()

    await expect(createShareClip(deps)('no-such-clip')).rejects.toThrow('Clip not found')
    expect(sharing.shareClipFile).not.toHaveBeenCalled()
  })
})
