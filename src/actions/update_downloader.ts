import type { FileDownloaderService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'

export interface UpdateDownloaderDeps {
  downloader: FileDownloaderService
  set: SetState
}

export type UpdateDownloader = Action<[]>

export const createUpdateDownloader: ActionFactory<UpdateDownloaderDeps, UpdateDownloader> = (deps) => (
  async () => {
    const { downloader, set } = deps

    set(state => { state.downloader.status = 'updating' })

    try {
      const result = await downloader.update()
      const version = await downloader.version()

      set(state => {
        state.downloader.version = version
        state.downloader.status = result === 'ALREADY_UP_TO_DATE' ? 'up-to-date' : 'updated'
      })
    } catch {
      set(state => { state.downloader.status = 'error' })
    }
  }
)
