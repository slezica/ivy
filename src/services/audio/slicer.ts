/**
 * Audio Slicer Service
 *
 * Extracts audio segments from files using native AudioSlicer module.
 * Used for clip sharing and transcription.
 */

import { NativeModules } from 'react-native'
import RNFS from 'react-native-fs'
import { createLogger } from '../../utils'

const log = createLogger('AudioSlicer')

// =============================================================================
// Public Interface
// =============================================================================

export interface SliceOptions {
  sourceUri: string
  startMs: number
  endMs: number
  outputPrefix?: string
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
    const { sourceUri, startMs, endMs, outputPrefix, outputDir } = options

    const inputPath = uriToPath(sourceUri)
    const prefix = outputPrefix ?? `slice_${Date.now()}`
    const baseDir = outputDir ?? RNFS.CachesDirectoryPath
    const outputPath = `${baseDir}/${prefix}`

    log(`Slicing: ${startMs}ms-${endMs}ms → ${outputPath}`)

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

    log('Slice complete:', normalizedPath)

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
      log('Cleanup failed:', error)
    }
  }

  /**
   * Move a file from one path to another, replacing the destination if it exists.
   */
  async move(fromPath: string, toPath: string): Promise<void> {
    const src = uriToPath(fromPath)
    const dst = uriToPath(toPath)

    if (await RNFS.exists(dst)) {
      await RNFS.unlink(dst)
    }

    await RNFS.moveFile(src, dst)
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
