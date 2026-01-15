/**
 * Sharing Service
 *
 * Extracts audio clips and shares them via native share sheet.
 */

import * as Sharing from 'expo-sharing'

import type { Clip } from '../storage/database'
import type { AudioSlicerService } from '../audio/slicer'

// =============================================================================
// Public Interface
// =============================================================================

export interface SharingServiceDeps {
  slicer: AudioSlicerService
}

// =============================================================================
// Service
// =============================================================================

export class SharingService {
  private slicer: AudioSlicerService

  constructor(deps: SharingServiceDeps) {
    this.slicer = deps.slicer
  }

  /**
   * Extract a clip segment and share it via native share sheet.
   */
  async shareClip(clip: Clip, sourceFileUri: string, title?: string): Promise<void> {
    let slicePath: string | null = null

    try {
      const result = await this.slicer.slice({
        sourceUri: sourceFileUri,
        startMs: clip.start,
        endMs: clip.start + clip.duration,
        outputFilename: `clip_${clip.id}_${Date.now()}.mp3`,
      })

      slicePath = result.path

      if (!(await Sharing.isAvailableAsync())) {
        throw new Error('Sharing is not available on this device')
      }

      await Sharing.shareAsync(result.uri, {
        dialogTitle: title || clip.note || 'Audio Clip',
        UTI: 'public.audio',
        mimeType: 'audio/*',
      })
    } catch (error) {
      console.error('Error sharing clip:', error)
      throw error
    } finally {
      if (slicePath) {
        await this.slicer.cleanup(slicePath)
      }
    }
  }
}
