/**
 * Sharing Service
 *
 * Shares audio clips via native share sheet.
 */

import * as Sharing from 'expo-sharing'

// =============================================================================
// Service
// =============================================================================

export class SharingService {
  /**
   * Share an existing clip audio file via native share sheet.
   */
  async shareClipFile(clipUri: string, title?: string): Promise<void> {
    try {
      console.log('[Sharing] Attempting to share:', clipUri)

      if (!(await Sharing.isAvailableAsync())) {
        throw new Error('Sharing is not available on this device')
      }

      // Verify file exists before sharing
      const path = clipUri.replace('file://', '')
      const { default: RNFS } = await import('react-native-fs')
      const exists = await RNFS.exists(path)
      console.log('[Sharing] File exists:', exists, 'at path:', path)

      if (!exists) {
        throw new Error(`Clip file not found: ${path}`)
      }

      const stat = await RNFS.stat(path)
      console.log('[Sharing] File size:', stat.size, 'bytes')

      await Sharing.shareAsync(clipUri, {
        dialogTitle: title || 'Audio Clip',
        UTI: 'public.mpeg-audio',
        mimeType: 'audio/mpeg',
      })

    } catch (error) {
      console.error('Error sharing clip:', error)
      throw error
    }
  }
}
