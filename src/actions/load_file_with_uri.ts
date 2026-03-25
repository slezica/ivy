import type { Action, ActionFactory } from '../store/types'
import type { LoadFile } from './load_file'
import { createLogger } from '../utils'


export interface LoadFileWithUriDeps {
  loadFile: LoadFile
}

export type LoadFileWithUri = Action<[string, string]>

export const createLoadFileWithUri: ActionFactory<LoadFileWithUriDeps, LoadFileWithUri> = (deps) => (
  async (uri, name) => {
    const { loadFile } = deps
    const log = createLogger('LoadFileWithUri')

    log(`Loading "${name}"`)

    await loadFile({ uri, name })
  }
)
