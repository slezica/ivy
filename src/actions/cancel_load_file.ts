import type { FileCopierService } from '../services'
import type { GetState, SetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'

export interface CancelLoadFileDeps {
  copier: FileCopierService
  get: GetState
  set: SetState
}

export type CancelLoadFile = Action<[]>

export const createCancelLoadFile: ActionFactory<CancelLoadFileDeps, CancelLoadFile> = (deps) => (
  async () => {
    const { copier, get, set } = deps
    const log = createLogger('CancelLoadFile')

    const opId = get().library.addOpId

    if (!opId) return

    log(`Cancelling operation ${opId}`)

    // Dismiss immediately — loadFile catch will handle cleanup in background
    set(state => {
      state.library.status = 'idle'
      state.library.addProgress = null
      state.library.addOpId = null
      state.library.message = null
    })

    // Signal native side to cancel the in-progress copy
    await copier.cancelCopy(opId).catch(() => {})
  }
)
