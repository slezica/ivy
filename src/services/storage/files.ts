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

// How many bytes to read for fingerprint
const FINGERPRINT_BYTES = 4096

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


// =============================================================================
// Helpers
// =============================================================================

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
