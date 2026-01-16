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
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error('Sharing is not available on this device')
      }

      await Sharing.shareAsync(clipUri, {
        dialogTitle: title || 'Audio Clip',
        UTI: 'public.audio',
        mimeType: 'audio/*',
      })
    } catch (error) {
      console.error('Error sharing clip:', error)
      throw error
    }
  }
}
