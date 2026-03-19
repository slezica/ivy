import type { FileCopierService } from '../services'
import type { GetState, SetState, Action, ActionFactory } from '../store/types'

export interface CancelLoadFileDeps {
  copier: FileCopierService
  get: GetState
  set: SetState
}

export type CancelLoadFile = Action<[]>

export const createCancelLoadFile: ActionFactory<CancelLoadFileDeps, CancelLoadFile> = (deps) => (
  async () => {
    const { copier, get, set } = deps
    const opId = get().library.copyOpId

    if (!opId) return

    // Dismiss immediately — loadFile's catch will handle cleanup in background
    set(state => {
      state.library.status = 'idle'
      state.library.copyProgress = null
      state.library.copyOpId = null
    })

    // Signal native side (non-blocking from the user's perspective)
    await copier.cancelCopy(opId)
  }
)
