/**
 * Audio Slicer Service
 *
 * Extracts audio segments from files using native AudioSlicer module.
 * Used for clip sharing and transcription.
 */

import { NativeModules } from 'react-native'
import RNFS from 'react-native-fs'

// =============================================================================
// Public Interface
// =============================================================================

export interface SliceOptions {
  sourceUri: string
  startMs: number
  endMs: number
  outputFilename?: string
  outputDir?: string  // Defaults to CachesDirectoryPath
}

export interface SliceResult {
  path: string      // Absolute path (no file:// prefix)
  uri: string       // file:// URI
}

// =============================================================================
// Service
// =============================================================================

export class AudioSlicerService {
  /**
   * Extract an audio segment to a temporary file.
   * Caller is responsible for cleanup via `cleanup()`.
   */
  async slice(options: SliceOptions): Promise<SliceResult> {
    const { sourceUri, startMs, endMs, outputFilename, outputDir } = options

    const inputPath = uriToPath(sourceUri)
    const filename = outputFilename ?? `slice_${Date.now()}.mp3`
    const baseDir = outputDir ?? RNFS.CachesDirectoryPath
    const outputPath = `${baseDir}/${filename}`

    console.log('[AudioSlicer] Slicing:', { inputPath, startMs, endMs, outputPath })

    const resultPath = await AudioSlicer.sliceAudio(
      inputPath,
      startMs,
      endMs,
      outputPath
    )

    const normalizedPath = uriToPath(resultPath)

    const exists = await RNFS.exists(normalizedPath)
    if (!exists) {
      throw new Error('Audio slice completed but output file not found')
    }

    console.log('[AudioSlicer] Slice complete:', normalizedPath)

    return {
      path: normalizedPath,
      uri: `file://${normalizedPath}`,
    }
  }

  /**
   * Clean up a temporary slice file.
   */
  async cleanup(pathOrUri: string): Promise<void> {
    try {
      const path = uriToPath(pathOrUri)
      const exists = await RNFS.exists(path)
      if (exists) {
        await RNFS.unlink(path)
      }
    } catch (error) {
      console.warn('[AudioSlicer] Cleanup failed:', error)
    }
  }

  /**
   * Ensure a directory exists, creating it if necessary.
   */
  async ensureDir(dirPath: string): Promise<void> {
    const exists = await RNFS.exists(dirPath)
    if (!exists) {
      await RNFS.mkdir(dirPath)
    }
  }
}


// =============================================================================
// Native Module
// =============================================================================

interface AudioSlicerInterface {
  sliceAudio(
    inputPath: string,
    startTimeMs: number,
    endTimeMs: number,
    outputPath: string
  ): Promise<string>
}

const { AudioSlicer } = NativeModules as {
  AudioSlicer: AudioSlicerInterface
}

// =============================================================================
// Helpers
// =============================================================================

function uriToPath(uri: string): string {
  return uri.startsWith('file://') ? uri.replace('file://', '') : uri
}
