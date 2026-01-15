import RNFS from 'react-native-fs'
import type { Clip } from './DatabaseService'
import AudioSlicer from './AudioSlicerModule'

const MAX_TRANSCRIPTION_DURATION_MS = 5000 // 5 seconds

/**
 * AudioExtractionService
 *
 * Extracts audio segments for transcription
 */
export class AudioExtractionService {
  /**
   * Extract audio segment for transcription (first 5 seconds of clip)
   * Returns path to temporary audio file (caller responsible for cleanup)
   */
  async extractForTranscription(clip: Clip, sourceFileUri: string): Promise<string> {
    const inputPath = sourceFileUri.replace('file://', '')

    const timestamp = Date.now()
    const outputFilename = `transcription_${clip.id}_${timestamp}.mp3`
    const outputPath = `${RNFS.CachesDirectoryPath}/${outputFilename}`

    const startTimeMs = clip.start
    const durationMs = Math.min(clip.duration, MAX_TRANSCRIPTION_DURATION_MS)
    const endTimeMs = startTimeMs + durationMs

    console.log('[AudioExtraction] Extracting for transcription:', {
      clipId: clip.id,
      startTimeMs,
      endTimeMs,
      durationMs,
    })

    const resultPath = await AudioSlicer.sliceAudio(
      inputPath,
      startTimeMs,
      endTimeMs,
      outputPath
    )

    // Verify output file exists
    const pathToCheck = resultPath.startsWith('file://')
      ? resultPath.replace('file://', '')
      : resultPath

    const exists = await RNFS.exists(pathToCheck)
    if (!exists) {
      throw new Error('Audio extraction completed but output file not found')
    }

    console.log('[AudioExtraction] Extraction complete:', resultPath)
    return pathToCheck
  }

  /**
   * Clean up temporary audio file
   */
  async cleanup(filePath: string): Promise<void> {
    try {
      const exists = await RNFS.exists(filePath)
      if (exists) {
        await RNFS.unlink(filePath)
      }
    } catch (error) {
      console.warn('[AudioExtraction] Cleanup failed:', error)
    }
  }
}

export const audioExtractionService = new AudioExtractionService()
