import { Paths, Directory, File } from 'expo-file-system'

/**
 * FileStorageService
 *
 * Manages copying external files to app-owned storage to avoid
 * content: URI invalidation issues.
 */
export class FileStorageService {
  private storageDir: Directory

  constructor() {
    // Use documentDirectory for app-owned storage
    this.storageDir = new Directory(Paths.document, 'audio')
  }

  private async ensureStorageDirectory(): Promise<void> {
    if (!(await this.storageDir.exists)) {
      await this.storageDir.create()
    }
  }

  /**
   * Copy a file from external URI to app storage
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

    const localFile = new File(this.storageDir, uniqueFilename)

    // For content: URIs (like Google Drive), File.copy() doesn't work
    // We need to read the data and write it manually
    if (externalUri.startsWith('content:')) {
      // Fetch the content from the content: URI
      const response = await fetch(externalUri)
      const arrayBuffer = await response.arrayBuffer()
      const uint8Array = new Uint8Array(arrayBuffer)

      // Write to local file
      await localFile.write(uint8Array)
    } else {
      // For file: URIs, use direct copy
      const sourceFile = new File(externalUri)
      await sourceFile.copy(localFile)
    }

    return localFile.uri
  }

  /**
   * Check if a file exists at the given URI
   */
  async fileExists(uri: string): Promise<boolean> {
    try {
      const file = new File(uri)
      return await file.exists
    } catch {
      return false
    }
  }

  /**
   * Delete a file from app storage
   */
  async deleteFile(uri: string): Promise<void> {
    try {
      const file = new File(uri)
      if (await file.exists) {
        await file.delete()
      }
    } catch (error) {
      console.error('Error deleting file:', error)
    }
  }
}
