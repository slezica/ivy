/**
 * File Storage Service
 *
 * Manages copying external files to app-owned storage.
 * Solves content: URI invalidation issues on Android.
 */

import { Paths, Directory } from 'expo-file-system'
import RNFS from 'react-native-fs'

// How many bytes to read for fingerprint
const FINGERPRINT_BYTES = 4096

// =============================================================================
// Service
// =============================================================================

export class FileStorageService {
  private storageDir: Directory
  private storagePath: string

  constructor() {
    this.storageDir = new Directory(Paths.document, 'audio')
    this.storagePath = `${RNFS.DocumentDirectoryPath}/audio`
  }

  /**
   * Copy a file from external URI to app storage.
   * If source is a local file (e.g., from cache), moves it instead of copying.
   * Returns the local file:// URI.
   */
  async copyToAppStorage(externalUri: string, filename: string): Promise<string> {
    await this.ensureStorageDirectory()

    const uniqueFilename = createUniqueFilename(filename)
    const localPath = `${this.storagePath}/${uniqueFilename}`

    // If source is already a local file, move instead of copy to save disk space
    const isLocalFile = externalUri.startsWith('file://') || externalUri.startsWith('/')
    if (isLocalFile) {
      const sourcePath = uriToPath(externalUri)

      // Verify source exists before attempting move
      const sourceExists = await RNFS.exists(sourcePath)
      console.log('Source file check:', { sourcePath, exists: sourceExists })

      if (!sourceExists) {
        throw new Error(`Source file does not exist: ${sourcePath}`)
      }

      const stat = await RNFS.stat(sourcePath)
      console.log('Source file stat:', { size: stat.size, isFile: stat.isFile() })

      await RNFS.moveFile(sourcePath, localPath)
    } else {
      console.log('Copying from content URI:', externalUri)
      await RNFS.copyFile(externalUri, localPath)
    }

    // Verify destination exists after copy/move
    const destExists = await RNFS.exists(localPath)
    console.log('Destination file check:', { localPath, exists: destExists })

    if (!destExists) {
      throw new Error(`File copy/move failed: destination does not exist`)
    }

    return `file://${localPath}`
  }

  /**
   * Check if a file exists at the given URI.
   */
  async fileExists(uri: string): Promise<boolean> {
    try {
      const path = uriToPath(uri)
      return await RNFS.exists(path)
    } catch {
      return false
    }
  }

  /**
   * Delete a file from app storage.
   */
  async deleteFile(uri: string): Promise<void> {
    try {
      const path = uriToPath(uri)
      const exists = await RNFS.exists(path)
      if (exists) {
        await RNFS.unlink(path)
      }
    } catch (error) {
      console.error('Error deleting file:', error)
    }
  }

  /**
   * Read file fingerprint for identity matching.
   * Returns file size and first N bytes as Uint8Array.
   */
  async readFileFingerprint(uri: string): Promise<{ fileSize: number; fingerprint: Uint8Array }> {
    const path = uriToPath(uri)
    const stat = await RNFS.stat(path)
    const fileSize = stat.size

    // Read first N bytes as base64, then decode to Uint8Array
    const headBase64 = await RNFS.read(path, FINGERPRINT_BYTES, 0, 'base64')
    const fingerprint = base64ToUint8Array(headBase64)

    return { fileSize, fingerprint }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async ensureStorageDirectory(): Promise<void> {
    if (!(await this.storageDir.exists)) {
      await this.storageDir.create()
    }

    const exists = await RNFS.exists(this.storagePath)
    if (!exists) {
      await RNFS.mkdir(this.storagePath)
    }
  }
}


// =============================================================================
// Helpers
// =============================================================================

function uriToPath(uri: string): string {
  return uri.replace('file://', '')
}

function createUniqueFilename(filename: string): string {
  // Remove characters that cause issues with Android MediaMetadataRetriever
  // Colons, brackets, and other special chars break setDataSource()
  const sanitized = filename.replace(/[/\\:*?"<>|[\]]/g, '_')
  const timestamp = Date.now()
  const dotIndex = sanitized.lastIndexOf('.')
  const nameWithoutExt = sanitized.substring(0, dotIndex)
  const extension = sanitized.substring(dotIndex)
  return `${nameWithoutExt}_${timestamp}${extension}`
}

/**
 * Convert base64 string to Uint8Array.
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}
