import type { Action, ActionFactory } from '../store/types'
import type { LoadFile } from './load_file'


export interface LoadFileWithUriDeps {
  loadFile: LoadFile
}

export type LoadFileWithUri = Action<[string, string]>

export const createLoadFileWithUri: ActionFactory<LoadFileWithUriDeps, LoadFileWithUri> = (deps) => (
  async (uri, name) => {
    await deps.loadFile({ uri, name })
  }
)
