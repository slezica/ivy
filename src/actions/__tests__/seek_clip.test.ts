import { createSeekClip, SeekClipDeps } from '../seek_clip'
import { MAIN_PLAYER_OWNER_ID } from '../../utils'
import { createMockClip, createMockState, createMockGet } from './helpers'


// -- Helpers ------------------------------------------------------------------

function createDeps(overrides?: Partial<SeekClipDeps>): SeekClipDeps {
  const clip = createMockClip()
  const state = createMockState({ clips: { [clip.id]: clip } })

  return {
    get: createMockGet(state),
    play: jest.fn(async () => {}),
    ...overrides,
  }
}


// -- Tests --------------------------------------------------------------------

describe('createSeekClip', () => {

  // -- Happy path -----------------------------------------------------------

  describe('happy path', () => {
    it('delegates to play with file_uri, start position, and MAIN_PLAYER_OWNER_ID', async () => {
      const deps = createDeps()
      const seekClip = createSeekClip(deps)

      await seekClip('clip-1')

      expect(deps.play).toHaveBeenCalledWith({
        fileUri: 'file:///audio/book-1.mp3',
        position: 10000,
        ownerId: MAIN_PLAYER_OWNER_ID,
      })
    })

    it('uses the clip start position from the matched clip', async () => {
      const clip = createMockClip({ id: 'clip-2', start: 42000 })
      const state = createMockState({ clips: { [clip.id]: clip } })
      const deps = createDeps({ get: createMockGet(state) })
      const seekClip = createSeekClip(deps)

      await seekClip('clip-2')

      const callArgs = (deps.play as jest.Mock).mock.calls[0][0]
      expect(callArgs.position).toBe(42000)
    })
  })

  // -- Validation -----------------------------------------------------------

  describe('validation', () => {
    it('throws when clip is not found', async () => {
      const state = createMockState({ clips: {} })
      const deps = createDeps({ get: createMockGet(state) })
      const seekClip = createSeekClip(deps)

      await expect(seekClip('nonexistent')).rejects.toThrow('Clip not found')
    })

    it('throws when clip has no source file', async () => {
      const clip = createMockClip({ id: 'clip-orphan', file_uri: null })
      const state = createMockState({ clips: { [clip.id]: clip } })
      const deps = createDeps({ get: createMockGet(state) })
      const seekClip = createSeekClip(deps)

      await expect(seekClip('clip-orphan')).rejects.toThrow('source file has been removed')
    })

    it('does not call play when clip is not found', async () => {
      const state = createMockState({ clips: {} })
      const deps = createDeps({ get: createMockGet(state) })
      const seekClip = createSeekClip(deps)

      await seekClip('nonexistent').catch(() => {})

      expect(deps.play).not.toHaveBeenCalled()
    })

    it('does not call play when clip has no source file', async () => {
      const clip = createMockClip({ file_uri: null })
      const state = createMockState({ clips: { [clip.id]: clip } })
      const deps = createDeps({ get: createMockGet(state) })
      const seekClip = createSeekClip(deps)

      await seekClip(clip.id).catch(() => {})

      expect(deps.play).not.toHaveBeenCalled()
    })
  })
})
