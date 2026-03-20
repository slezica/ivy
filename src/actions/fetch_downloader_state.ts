import type { FileDownloaderService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'

export interface FetchDownloaderStateDeps {
  downloader: FileDownloaderService
  set: SetState
}

export type FetchDownloaderState = Action<[]>

export const createFetchDownloaderState: ActionFactory<FetchDownloaderStateDeps, FetchDownloaderState> = (deps) => (
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
