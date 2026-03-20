import type { FileDownloaderService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'

export interface FetchDownloaderStatusDeps {
  downloader: FileDownloaderService
  set: SetState
}

export type FetchDownloaderStatus = Action<[]>

export const createFetchDownloaderStatus: ActionFactory<FetchDownloaderStatusDeps, FetchDownloaderStatus> = (deps) => (
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
