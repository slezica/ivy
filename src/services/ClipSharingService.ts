import * as Sharing from 'expo-sharing'
import RNFS from 'react-native-fs'
import type { Clip } from './DatabaseService'
import AudioSlicer from './AudioSlicerModule'

/**
 * ClipSharingService
 *
 * Extracts audio clip segments and shares them via native share sheet
 */
export class ClipSharingService {
  /**
   * Extract a clip segment and share it
   */
  async shareClip(clip: Clip, sourceFileUri: string, clipTitle?: string): Promise<void> {
    let outputPath: string | null = null

    try {
      // Extract the audio segment
      outputPath = await this.extractClipSegment(clip, sourceFileUri)

      // Check if sharing is available
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error('Sharing is not available on this device')
      }

      // Share via native share sheet
      await Sharing.shareAsync(outputPath, {
        dialogTitle: clipTitle || clip.note || 'Audio Clip',
        UTI: 'public.audio', // iOS
        mimeType: 'audio/*', // Android
      })
    } catch (error) {
      console.error('Error sharing clip:', error)
      throw error
    } finally {
      // Clean up temporary file
      if (outputPath) {
        try {
          await RNFS.unlink(outputPath)
        } catch (cleanupError) {
          console.warn('Failed to cleanup temp file:', cleanupError)
        }
      }
    }
  }

  /**
   * Extract audio segment using native AudioSlicer module
   * Returns path to the extracted file
   */
  private async extractClipSegment(clip: Clip, sourceFileUri: string): Promise<string> {
    // Convert URI to path
    const inputPath = sourceFileUri.replace('file://', '')

    // Create output file in cache directory
    const timestamp = Date.now()
    const outputFilename = `clip_${clip.id}_${timestamp}.mp3`
    const outputPath = `${RNFS.CachesDirectoryPath}/${outputFilename}`

    const startTimeMs = clip.start
    const endTimeMs = clip.start + clip.duration

    console.log('Slicing audio:', { inputPath, startTimeMs, endTimeMs, outputPath })

    // Slice audio segment using native module
    const resultPath = await AudioSlicer.sliceAudio(
      inputPath,
      startTimeMs,
      endTimeMs,
      outputPath
    )

    console.log('Slice result (raw):', resultPath)

    // Ensure we have a file:// URI for expo-sharing
    const fileUri = resultPath.startsWith('file://') ? resultPath : `file://${resultPath}`
    console.log('Slice result (file URI):', fileUri)

    // Verify output file exists (check without file:// prefix)
    const pathToCheck = fileUri.replace('file://', '')
    const exists = await RNFS.exists(pathToCheck)
    console.log('File exists check:', { pathToCheck, exists })

    if (!exists) {
      throw new Error('Slice completed but output file not found')
    }

    console.log('Clip extracted successfully:', fileUri)
    return fileUri
  }
}
