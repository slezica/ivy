import { Paths, Directory, File } from 'expo-file-system'
import RNFS from 'react-native-fs'

/**
 * FileStorageService
 *
 * Manages copying external files to app-owned storage to avoid
 * content: URI invalidation issues.
 * Uses react-native-fs for native file operations with content: URIs
 */
export class FileStorageService {
  private storageDir: Directory
  private storagePath: string

  constructor() {
    // Use documentDirectory for app-owned storage
    this.storageDir = new Directory(Paths.document, 'audio')
    // RNFS uses string paths
    this.storagePath = `${RNFS.DocumentDirectoryPath}/audio`
  }

  private async ensureStorageDirectory(): Promise<void> {
    // Check with Expo FileSystem API
    if (!(await this.storageDir.exists)) {
      await this.storageDir.create()
    }

    // Also ensure it exists with RNFS
    const exists = await RNFS.exists(this.storagePath)
    if (!exists) {
      await RNFS.mkdir(this.storagePath)
    }
  }

  /**
   * Copy a file from external URI to app storage
   * Uses react-native-fs for native streaming copy (no OOM)
   * Returns the local file:// URI
   */
  async copyToAppStorage(externalUri: string, filename: string): Promise<string> {
    await this.ensureStorageDirectory()

    // Sanitize filename (remove path separators, keep extension)
    const sanitized = filename.replace(/[/\\]/g, '_')

    // Create unique filename using timestamp to avoid collisions
    const timestamp = Date.now()
    const extension = sanitized.substring(sanitized.lastIndexOf('.'))
    const nameWithoutExt = sanitized.substring(0, sanitized.lastIndexOf('.'))
    const uniqueFilename = `${nameWithoutExt}_${timestamp}${extension}`

    const localPath = `${this.storagePath}/${uniqueFilename}`

    // Use RNFS native copy - handles content: URIs and large files efficiently
    await RNFS.copyFile(externalUri, localPath)

    // Return as file:// URI
    return `file://${localPath}`
  }

  /**
   * Check if a file exists at the given URI
   */
  async fileExists(uri: string): Promise<boolean> {
    try {
      // Convert file:// URI to path
      const path = uri.replace('file://', '')
      return await RNFS.exists(path)
    } catch {
      return false
    }
  }

  /**
   * Delete a file from app storage
   */
  async deleteFile(uri: string): Promise<void> {
    try {
      // Convert file:// URI to path
      const path = uri.replace('file://', '')
      const exists = await RNFS.exists(path)
      if (exists) {
        await RNFS.unlink(path)
      }
    } catch (error) {
      console.error('Error deleting file:', error)
    }
  }
}
