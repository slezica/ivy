import { NativeModules } from 'react-native'

const { AudioMetadataModule } = NativeModules

export interface AudioMetadata {
  title: string | null
  artist: string | null
  artwork: string | null // base64 data URI
}

/**
 * MetadataService
 *
 * Reads metadata from audio files using native Android MediaMetadataRetriever.
 * This provides efficient metadata extraction without loading the entire file into memory.
 *
 * AVAILABLE METADATA FIELDS (from MediaMetadataRetriever):
 * Currently extracted:
 * - title: Track title (METADATA_KEY_TITLE)
 * - artist: Track artist/author (METADATA_KEY_ARTIST or METADATA_KEY_ALBUMARTIST)
 * - artwork: Album/track artwork (embedded picture, converted to base64 JPEG)
 *
 * Additional fields available (not currently extracted):
 * - album: Album name (METADATA_KEY_ALBUM)
 * - albumArtist: Album artist (METADATA_KEY_ALBUMARTIST)
 * - author: Author/composer (METADATA_KEY_AUTHOR)
 * - composer: Composer name (METADATA_KEY_COMPOSER)
 * - writer: Writer (METADATA_KEY_WRITER)
 * - genre: Music genre (METADATA_KEY_GENRE)
 * - year: Release year (METADATA_KEY_YEAR)
 * - date: Release date (METADATA_KEY_DATE)
 * - duration: Track duration in milliseconds (METADATA_KEY_DURATION)
 * - trackNumber: Track number (METADATA_KEY_CD_TRACK_NUMBER)
 * - discNumber: Disc number (METADATA_KEY_DISC_NUMBER)
 * - compilation: Compilation flag (METADATA_KEY_COMPILATION)
 * - bitrate: Bitrate (METADATA_KEY_BITRATE)
 * - mimetype: MIME type (METADATA_KEY_MIMETYPE)
 *
 * Supported formats: MP3, M4A, M4B, AAC, OGG, FLAC, WAV, and other formats
 * supported by Android MediaMetadataRetriever
 */
export class MetadataService {
  /**
   * Read metadata from an audio file using native module
   * Returns null values for any missing metadata
   */
  async readMetadata(fileUri: string): Promise<AudioMetadata> {
    try {
      // Convert file:// URI to absolute path
      const filePath = fileUri.replace('file://', '')

      // Call native module to extract metadata
      const metadata = await AudioMetadataModule.extractMetadata(filePath)

      console.log('Metadata extracted:', {
        title: metadata.title,
        artist: metadata.artist,
        hasArtwork: !!metadata.artwork,
      })

      return {
        title: metadata.title || null,
        artist: metadata.artist || null,
        artwork: metadata.artwork || null,
      }
    } catch (error) {
      console.error('Failed to read metadata:', error)
      // Return empty metadata on error
      return {
        title: null,
        artist: null,
        artwork: null,
      }
    }
  }
}

