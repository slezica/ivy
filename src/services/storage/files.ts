/**
 * File Storage Service
 *
 * Manages copying external files to app-owned storage.
 * Solves content: URI invalidation issues on Android.
 */

import { Paths, Directory } from 'expo-file-system'
import RNFS from 'react-native-fs'

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
   * Returns the local file:// URI.
   */
  async copyToAppStorage(externalUri: string, filename: string): Promise<string> {
    await this.ensureStorageDirectory()

    const uniqueFilename = createUniqueFilename(filename)
    const localPath = `${this.storagePath}/${uniqueFilename}`

    await RNFS.copyFile(externalUri, localPath)

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
// Singleton
// =============================================================================

export const fileStorageService = new FileStorageService()

// =============================================================================
// Helpers
// =============================================================================

function uriToPath(uri: string): string {
  return uri.replace('file://', '')
}

function createUniqueFilename(filename: string): string {
  const sanitized = filename.replace(/[/\\]/g, '_')
  const timestamp = Date.now()
  const dotIndex = sanitized.lastIndexOf('.')
  const nameWithoutExt = sanitized.substring(0, dotIndex)
  const extension = sanitized.substring(dotIndex)
  return `${nameWithoutExt}_${timestamp}${extension}`
}
