import type { FileDownloaderService } from '../services'
import type { GetState, SetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'

export interface UpdateDownloaderDeps {
  downloader: FileDownloaderService
  get: GetState
  set: SetState
}

export type UpdateDownloader = Action<[]>

export const createUpdateDownloader: ActionFactory<UpdateDownloaderDeps, UpdateDownloader> = (deps) => (
  async () => {
    const { downloader, set } = deps
    const log = createLogger('UpdateDownloader')

    if (deps.get().downloader.status !== 'idle') return

    log('Updating yt-dlp')

    set(state => { state.downloader.status = 'updating' })

    try {
      await downloader.update()
      const version = await downloader.version()
      log(`Updated to ${version}`)
      set(state => { state.downloader.version = version })
    } finally {
      set(state => { state.downloader.status = 'idle' })
    }
  }
)
