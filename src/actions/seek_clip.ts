import type { GetState, Action, ActionFactory } from '../store/types'
import type { Play } from './play'


export interface SeekClipDeps {
  get: GetState
  play: Play
}

export type SeekClip = Action<[string]>

export const createSeekClip: ActionFactory<SeekClipDeps, SeekClip> = (deps) => (
  async (clipId) => {
    const { get, play } = deps

    const clip = get().clips[clipId]
    if (!clip) {
      throw new Error('Clip not found')
    }
    if (!clip.file_uri) {
      throw new Error('Cannot seek to clip: source file has been removed')
    }

    // Seek to clip includes loading the file if different
    await play({ fileUri: clip.file_uri, position: clip.start })
  }
)
