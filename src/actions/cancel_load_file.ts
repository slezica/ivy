import type { FileCopierService, FileDownloaderService } from '../services'
import type { GetState, SetState, Action, ActionFactory } from '../store/types'

export interface CancelLoadFileDeps {
  copier: FileCopierService
  downloader: FileDownloaderService
  get: GetState
  set: SetState
}

export type CancelLoadFile = Action<[]>

export const createCancelLoadFile: ActionFactory<CancelLoadFileDeps, CancelLoadFile> = (deps) => (
  async () => {
    const { copier, downloader, get, set } = deps
    const opId = get().library.addOpId

    if (!opId) return

    // Dismiss immediately — loadFile/loadFromUrl catch will handle cleanup in background
    set(state => {
      state.library.status = 'idle'
      state.library.addProgress = null
      state.library.addOpId = null
      state.library.message = null
    })

    // Signal native side — cancel both copy and download (only one will be active)
    await Promise.all([
      copier.cancelCopy(opId).catch(() => {}),
      downloader.cancelDownload().catch(() => {}),
    ])
  }
)
