/**
 * Audio Metadata Service
 *
 * Reads metadata from audio files using native Android MediaMetadataRetriever.
 * Extracts title, artist, and album artwork without loading the entire file.
 *
 * Supported formats: MP3, M4A, M4B, AAC, OGG, FLAC, WAV
 */

import { NativeModules } from 'react-native'
import { createLogger } from '../../utils'

const log = createLogger('AudioMetadata')

// =============================================================================
// Public Interface
// =============================================================================

export interface AudioMetadata {
  title: string | null
  artist: string | null
  artwork: string | null  // base64 data URI
  duration: number        // milliseconds
}

// =============================================================================
// Service
// =============================================================================

export class AudioMetadataService {
  async readMetadata(fileUri: string): Promise<AudioMetadata> {
    try {
      const filePath = uriToPath(fileUri)
      const metadata = await AudioMetadataModule.extractMetadata(filePath)

      log(`Extracted: "${metadata.title || 'unknown'}" by ${metadata.artist || 'unknown'} (${metadata.duration}ms)`)

      return {
        title: metadata.title || null,
        artist: metadata.artist || null,
        artwork: metadata.artwork || null,
        duration: metadata.duration || 0,
      }
    } catch (error) {
      log('Failed to read metadata:', error)
      return {
        title: null,
        artist: null,
        artwork: null,
        duration: 0,
      }
    }
  }
}


// =============================================================================
// Native Module
// =============================================================================

interface AudioMetadataModuleInterface {
  extractMetadata(filePath: string): Promise<{
    title?: string
    artist?: string
    artwork?: string
    duration?: number
  }>
}

const { AudioMetadataModule } = NativeModules as {
  AudioMetadataModule: AudioMetadataModuleInterface
}

// =============================================================================
// Helpers
// =============================================================================

function uriToPath(uri: string): string {
  return uri.replace('file://', '')
}
