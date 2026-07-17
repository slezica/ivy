/**
 * Audio Slicer Service
 *
 * Extracts audio segments from files using native AudioSlicer module.
 * Used for clip sharing and transcription.
 */

import { NativeModules } from 'react-native'
import RNFS from 'react-native-fs'
import { createLogger, uriToPath } from '../../utils'

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
   * The existing destination is kept as a backup until the move succeeds, so a
   * failed move never loses the only copy of the file.
   */
  async move(fromPath: string, toPath: string): Promise<void> {
    const src = uriToPath(fromPath)
    const dst = uriToPath(toPath)
    const backup = `${dst}.bak`

    const replacing = await RNFS.exists(dst)

    if (replacing) {
      if (await RNFS.exists(backup)) {
        await RNFS.unlink(backup)
      }
      await RNFS.moveFile(dst, backup)
    }

    try {
      await RNFS.moveFile(src, dst)
    } catch (error) {
      if (replacing) {
        await RNFS.moveFile(backup, dst).catch(restoreError => {
          log('Failed to restore backup after move failure:', restoreError)
        })
      }
      throw error
    }

    if (replacing) {
      await RNFS.unlink(backup).catch(cleanupError => {
        log('Backup cleanup failed:', cleanupError)
      })
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

  /**
   * Warm the FFmpeg runtime in the background (unpacks the library bundle and
   * pays the one-time cold-link cost), so the first clip slice or chapter read
   * isn't slow. Fire-and-forget; safe to call before any real slice.
   */
  async warmUp(): Promise<void> {
    await AudioSlicer.warmUp()
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
  warmUp(): Promise<void>
}

const { AudioSlicer } = NativeModules as {
  AudioSlicer: AudioSlicerInterface
}

// =============================================================================
// Helpers
// =============================================================================

