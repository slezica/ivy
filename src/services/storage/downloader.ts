/**
 * File Downloader Service
 *
 * Downloads audio from URLs via yt-dlp (native module). Supports YouTube and
 * other yt-dlp-supported sites. Downloads as m4a to avoid transcoding.
 *
 * Same progress callback pattern as FileCopierService.
 */

import { NativeModules, NativeEventEmitter } from 'react-native'

// =============================================================================
// Public Interface
// =============================================================================

export interface DownloadResult {
  filePath: string
}

export type DownloadProgressCallback = (percent: number) => void

// =============================================================================
// Service
// =============================================================================

export class FileDownloaderService {
  private nextOpId = 0

  /**
   * Download audio from a URL.
   * Calls onProgress periodically with percent (0-100).
   * Returns the local file path of the downloaded audio.
   */
  async download(
    url: string,
    outputDir: string,
    onProgress?: DownloadProgressCallback,
  ): Promise<DownloadResult> {
    const opId = String(this.nextOpId++)
    let subscription: { remove: () => void } | null = null

    if (onProgress) {
      const emitter = new NativeEventEmitter(NativeModules.FileDownloader)

      subscription = emitter.addListener('FileDownloaderProgress', (event) => {
        if (event.opId === opId) {
          onProgress(event.percent)
        }
      })
    }

    try {
      const result = await NativeFileDownloader.download(opId, url, outputDir)
      return { filePath: result.filePath }
    } finally {
      subscription?.remove()
    }
  }

  /**
   * Cancel any in-progress download.
   */
  async cancelDownload(): Promise<void> {
    await NativeFileDownloader.cancelDownload()
  }

  /**
   * Update yt-dlp to the latest stable version.
   * Returns a status string like "ALREADY_UP_TO_DATE" or "DONE".
   */
  async update(): Promise<string> {
    return await NativeFileDownloader.update()
  }

  /**
   * Get the current yt-dlp version string.
   */
  async version(): Promise<string> {
    return await NativeFileDownloader.version()
  }
}


// =============================================================================
// Native Module
// =============================================================================

interface NativeFileDownloaderInterface {
  download(opId: string, url: string, outputDir: string): Promise<{
    filePath: string
  }>

  cancelDownload(): Promise<void>

  update(): Promise<string>

  version(): Promise<string>
}

const { FileDownloader: NativeFileDownloader } = NativeModules as {
  FileDownloader: NativeFileDownloaderInterface
}
