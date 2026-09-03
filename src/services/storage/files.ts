/**
 * File Storage Service
 *
 * Manages files in app-owned storage: existence, stats, deletion, fingerprints,
 * listing. Import copies are performed by the native FileCopier module.
 */

import { Paths, Directory } from 'expo-file-system'
import RNFS from 'react-native-fs'
import { createLogger, uriToPath } from '../../utils'

const log = createLogger('FileStorage')

// =============================================================================
// Service
// =============================================================================

export class FileStorageService {
  private storageDir: Directory

  /** Absolute path to the audio storage directory (no file:// prefix). */
  readonly audioDirectoryPath: string

  constructor() {
    this.storageDir = new Directory(Paths.document, 'audio')
    this.audioDirectoryPath = `${RNFS.DocumentDirectoryPath}/audio`
  }

  /**
   * Modification time of a file in milliseconds since epoch, or null if unavailable.
   */
  async getModificationTime(uri: string): Promise<number | null> {
    try {
      const stat = await RNFS.stat(uriToPath(uri))
      return stat.mtime ? new Date(stat.mtime).getTime() : null
    } catch {
      return null
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
      log('Error deleting file:', error)
    }
  }

  /** List all files in a directory as file:// URIs. */
  async listFiles(dirPath: string): Promise<string[]> {
    const exists = await RNFS.exists(dirPath)
    if (!exists) return []

    const items = await RNFS.readDir(dirPath)
    return items
      .filter(item => item.isFile())
      .map(item => `file://${item.path}`)
  }

  /** Ensure the audio storage directory exists. */
  async ensureAudioDirectory(): Promise<void> {
    if (!(await this.storageDir.exists)) {
      await this.storageDir.create()
    }

    const exists = await RNFS.exists(this.audioDirectoryPath)
    if (!exists) {
      await RNFS.mkdir(this.audioDirectoryPath)
    }
  }
}


