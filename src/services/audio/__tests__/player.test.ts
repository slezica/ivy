/**
 * AudioPlayerService tests. TrackPlayer is mocked — these cover the fade
 * state machine (ramp, completion, cancellation) and what load() hands the
 * media session, not native playback.
 */

import TrackPlayer from 'react-native-track-player'
import { artworkFileUri } from '../artwork'
import { AudioPlayerService } from '../player'

// jest.mock calls are hoisted above the imports
jest.mock('react-native-track-player', () => ({
  __esModule: true,
  default: {
    setVolume: jest.fn(async () => {}),
    setupPlayer: jest.fn(async () => {}),
    updateOptions: jest.fn(async () => {}),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    reset: jest.fn(async () => {}),
    add: jest.fn(async () => {}),
    getProgress: jest.fn(async () => ({ duration: 60 })),
  },
  Capability: {},
  Event: {},
  State: {},
  AppKilledPlaybackBehavior: {},
}))

jest.mock('../artwork', () => ({
  artworkFileUri: jest.fn(),
}))

const setVolume = TrackPlayer.setVolume as jest.Mock
const add = TrackPlayer.add as jest.Mock
const artworkFile = artworkFileUri as jest.Mock


describe('AudioPlayerService fade', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    setVolume.mockClear()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('ramps volume down and resolves true on completion', async () => {
    const audio = new AudioPlayerService()

    const fade = audio.fadeOut(1_000)
    await jest.advanceTimersByTimeAsync(0)
    expect(setVolume).toHaveBeenCalledWith(1)  // fade starts from full volume

    await jest.advanceTimersByTimeAsync(250)
    expect(setVolume).toHaveBeenLastCalledWith(0.75)

    await jest.advanceTimersByTimeAsync(250)
    expect(setVolume).toHaveBeenLastCalledWith(0.5)

    await jest.advanceTimersByTimeAsync(500)
    await expect(fade).resolves.toBe(true)
    expect(setVolume).toHaveBeenLastCalledWith(0)
  })

  it('resetVolume cancels a running fade and restores full volume', async () => {
    const audio = new AudioPlayerService()

    const fade = audio.fadeOut(1_000)
    await jest.advanceTimersByTimeAsync(500)

    await audio.resetVolume()
    await expect(fade).resolves.toBe(false)
    expect(setVolume).toHaveBeenLastCalledWith(1)

    // No further ramp ticks after cancellation
    setVolume.mockClear()
    await jest.advanceTimersByTimeAsync(2_000)
    expect(setVolume).not.toHaveBeenCalled()
  })

  it('starting a new fade cancels the previous one', async () => {
    const audio = new AudioPlayerService()

    const first = audio.fadeOut(1_000)
    await jest.advanceTimersByTimeAsync(500)

    const second = audio.fadeOut(1_000)
    await expect(first).resolves.toBe(false)

    await jest.advanceTimersByTimeAsync(1_000)
    await expect(second).resolves.toBe(true)
    expect(setVolume).toHaveBeenLastCalledWith(0)
  })

  it('resetVolume without a running fade just restores volume', async () => {
    const audio = new AudioPlayerService()

    await audio.resetVolume()
    expect(setVolume).toHaveBeenCalledWith(1)
  })
})


describe('AudioPlayerService load artwork', () => {
  const METADATA = { title: 'Book', artist: 'Author', artwork: 'data:image/jpeg;base64,AAAA' }

  beforeEach(() => {
    add.mockClear()
    artworkFile.mockReset()
  })

  it('hands the media session a file URI, never the data URI', async () => {
    artworkFile.mockResolvedValue('file:///cache/artwork/abc-4.jpg')

    await new AudioPlayerService().load('file:///book.m4a', METADATA)

    expect(artworkFile).toHaveBeenCalledWith(METADATA.artwork)
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ artwork: 'file:///cache/artwork/abc-4.jpg' }))
  })

  it('loads without a cover when the artwork file cannot be written', async () => {
    artworkFile.mockRejectedValue(new Error('ENOSPC'))

    await expect(new AudioPlayerService().load('file:///book.m4a', METADATA)).resolves.toBe(60_000)

    expect(add).toHaveBeenCalledWith(expect.objectContaining({ artwork: undefined }))
  })

  it('loads without a cover when the book has none', async () => {
    artworkFile.mockResolvedValue(null)

    await new AudioPlayerService().load('file:///book.m4a', { title: 'Book' })

    expect(add).toHaveBeenCalledWith(expect.objectContaining({ artwork: undefined }))
  })
})
