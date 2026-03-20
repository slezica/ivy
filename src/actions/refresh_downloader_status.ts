import type { FileDownloaderService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'

export interface RefreshDownloaderStatusDeps {
  downloader: FileDownloaderService
  set: SetState
}

export type RefreshDownloaderStatus = Action<[]>

export const createRefreshDownloaderStatus: ActionFactory<RefreshDownloaderStatusDeps, RefreshDownloaderStatus> = (deps) => (
  async () => {
    const { downloader, set } = deps

    try {
      const version = await downloader.version()
      set(state => { state.downloader.version = version })
    } catch {
      // Non-critical — leave version as-is
    }
  }
)
