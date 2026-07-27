/**
 * Sharing Service
 *
 * Shares audio clips via native share sheet.
 */

import * as Sharing from 'expo-sharing'
import { createLogger } from '../../utils'

const log = createLogger('Sharing')

// Cache subdirectory for friendly-named share copies. Lives in the OS cache
// dir, so leftovers are purged under storage pressure regardless of our own
// cleanup.
const SHARE_DIR_NAME = 'share'

// Share copies older than this are deleted at the next share. Not immediately
// after sharing: recipients (e.g. a backgrounded Drive upload) may read the
// content URI well after the sheet closes.
const STALE_SHARE_MS = 24 * 60 * 60 * 1000

// =============================================================================
// Service
// =============================================================================

export class SharingService {
  /**
   * Share an existing clip audio file via native share sheet.
   *
   * When `filename` is given, the file is shared through a copy with that name
   * in the share cache dir, so recipient apps display it instead of the
   * internal UUID name. If the copy fails, falls back to sharing the original.
   */
  async shareClipFile(clipUri: string, title?: string, filename?: string): Promise<void> {
    try {
      log('Sharing:', clipUri)

      if (!(await Sharing.isAvailableAsync())) {
        throw new Error('Sharing is not available on this device')
      }

      // Verify file exists before sharing
      const path = clipUri.replace('file://', '')
      const { default: RNFS } = await import('react-native-fs')
      const exists = await RNFS.exists(path)

      if (!exists) {
        throw new Error(`Clip file not found: ${path}`)
      }

      const stat = await RNFS.stat(path)
      log(`File: ${stat.size} bytes`)

      let shareUri = clipUri
      if (filename) {
        try {
          shareUri = await this.prepareShareCopy(path, filename)
        } catch (error) {
          log('Share copy failed, sharing original:', error)
        }
      }

      // Determine MIME type based on file extension
      const isM4a = path.toLowerCase().endsWith('.m4a')
      const mimeType = isM4a ? 'audio/mp4' : 'audio/mpeg'
      const uti = isM4a ? 'public.mpeg-4-audio' : 'public.mp3'

      await Sharing.shareAsync(shareUri, {
        dialogTitle: title || 'Audio Clip',
        UTI: uti,
        mimeType: mimeType,
      })

    } catch (error) {
      log('Error sharing clip:', error)
      throw error
    }
  }

  /**
   * Copy the clip into the share cache dir under a friendly name, deleting
   * stale copies from earlier shares first. Returns the copy's file:// URI.
   */
  private async prepareShareCopy(srcPath: string, filename: string): Promise<string> {
    const { default: RNFS } = await import('react-native-fs')
    const shareDir = `${RNFS.CachesDirectoryPath}/${SHARE_DIR_NAME}`

    await this.cleanupStaleShares(shareDir)
    await RNFS.mkdir(shareDir)

    const destPath = `${shareDir}/${filename}`
    if (await RNFS.exists(destPath)) {
      await RNFS.unlink(destPath)
    }
    await RNFS.copyFile(srcPath, destPath)

    return `file://${destPath}`
  }

  private async cleanupStaleShares(shareDir: string): Promise<void> {
    try {
      const { default: RNFS } = await import('react-native-fs')
      if (!(await RNFS.exists(shareDir))) return

      const now = Date.now()
      const items = await RNFS.readDir(shareDir)
      for (const item of items) {
        const mtime = item.mtime ? new Date(item.mtime).getTime() : 0
        if (item.isFile() && now - mtime > STALE_SHARE_MS) {
          await RNFS.unlink(item.path).catch(() => {})
        }
      }
    } catch (error) {
      // Best-effort: a failed cleanup never blocks the share
      log('Stale share cleanup failed:', error)
    }
  }
}
