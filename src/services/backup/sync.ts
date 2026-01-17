/**
 * Backup Sync Service
 *
 * Orchestrates synchronization between local database and Google Drive.
 * Handles diffing, uploading, and downloading of books and clips.
 */

import RNFS from 'react-native-fs'
import { databaseService, Book, Clip } from '../storage'
import { googleDriveService, DriveFile } from './drive'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BookBackup {
  id: string
  name: string
  duration: number
  position: number
  updated_at: number
  title: string | null
  artist: string | null
  artwork: string | null
  file_size: number
  fingerprint: string // base64-encoded
}

export interface ClipBackup {
  id: string
  source_id: string
  start: number
  duration: number
  note: string
  transcription: string | null
  created_at: number
  updated_at: number
}

export interface SyncResult {
  uploaded: { books: number; clips: number }
  downloaded: { books: number; clips: number }
  deleted: { clips: number }
  errors: string[]
}

// Filename format: {type}_{id}_{timestamp}.{ext}
// e.g., book_abc123_1705432800000.json, clip_def456_1705432800000.mp3
const FILENAME_REGEX = /^(book|clip)_([a-f0-9-]+)_(\d+)\.(json|mp3)$/

interface ParsedFilename {
  type: 'book' | 'clip'
  id: string
  timestamp: number
  extension: 'json' | 'mp3'
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class BackupSyncService {
  /**
   * Perform full bidirectional sync.
   */
  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: { books: 0, clips: 0 },
      downloaded: { books: 0, clips: 0 },
      deleted: { clips: 0 },
      errors: [],
    }

    try {
      // Sync books first (clips depend on books)
      await this.syncBooks(result)
      await this.syncClips(result)
    } catch (error) {
      result.errors.push(`Sync failed: ${error}`)
    }

    console.log('Sync complete:', result)
    return result
  }

  // ---------------------------------------------------------------------------
  // Books
  // ---------------------------------------------------------------------------

  private async syncBooks(result: SyncResult): Promise<void> {
    const localBooks = databaseService.getAllBooks()
    const remoteFiles = await googleDriveService.listFiles('books')

    // Group remote files by book ID, keeping only latest timestamp
    const remoteByBookId = this.groupByLatest(remoteFiles, 'book')

    // Track which books exist remotely for cleanup later
    const remoteBookIds = new Set(remoteByBookId.keys())
    const localBookIds = new Set(localBooks.map(b => b.id))

    // Upload local books that are newer or don't exist remotely
    for (const book of localBooks) {
      const remote = remoteByBookId.get(book.id)

      if (!remote || book.updated_at > remote.timestamp) {
        try {
          await this.uploadBook(book)
          result.uploaded.books++

          // Delete old version if exists
          if (remote) {
            await googleDriveService.deleteFile(remote.file.id)
          }
        } catch (error) {
          result.errors.push(`Failed to upload book ${book.id}: ${error}`)
        }
      }
    }

    // Download remote books that are newer or don't exist locally
    for (const [bookId, remote] of remoteByBookId) {
      const localBook = localBooks.find(b => b.id === bookId)

      if (!localBook || remote.timestamp > localBook.updated_at) {
        try {
          await this.downloadBook(remote.file)
          result.downloaded.books++
        } catch (error) {
          result.errors.push(`Failed to download book ${bookId}: ${error}`)
        }
      }
    }

    // Clean up old versions (files with same ID but older timestamp)
    await this.cleanupOldVersions(remoteFiles, 'book')
  }

  private async uploadBook(book: Book): Promise<void> {
    const backup: BookBackup = {
      id: book.id,
      name: book.name,
      duration: book.duration,
      position: book.position,
      updated_at: book.updated_at,
      title: book.title,
      artist: book.artist,
      artwork: book.artwork,
      file_size: book.file_size,
      fingerprint: uint8ArrayToBase64(book.fingerprint),
    }

    const filename = `book_${book.id}_${book.updated_at}.json`
    const content = JSON.stringify(backup, null, 2)

    await googleDriveService.uploadFile('books', filename, content)
    console.log(`Uploaded book: ${filename}`)
  }

  private async downloadBook(file: DriveFile): Promise<void> {
    const content = await googleDriveService.downloadFile(file.id, false) as string
    const backup: BookBackup = JSON.parse(content)

    databaseService.restoreBookFromBackup(
      backup.id,
      backup.name,
      backup.duration,
      backup.position,
      backup.updated_at,
      backup.title,
      backup.artist,
      backup.artwork,
      backup.file_size,
      base64ToUint8Array(backup.fingerprint)
    )

    console.log(`Downloaded book: ${backup.id}`)
  }

  // ---------------------------------------------------------------------------
  // Clips
  // ---------------------------------------------------------------------------

  private async syncClips(result: SyncResult): Promise<void> {
    const localClips = databaseService.getAllClips()
    const remoteFiles = await googleDriveService.listFiles('clips')

    // Group remote JSON files by clip ID (ignore MP3s for now, they're paired)
    const remoteJsonFiles = remoteFiles.filter(f => f.name.endsWith('.json'))
    const remoteByClipId = this.groupByLatest(remoteJsonFiles, 'clip')

    const localClipIds = new Set(localClips.map(c => c.id))

    // Upload local clips that are newer or don't exist remotely
    for (const clip of localClips) {
      const remote = remoteByClipId.get(clip.id)

      if (!remote || clip.updated_at > remote.timestamp) {
        try {
          await this.uploadClip(clip)
          result.uploaded.clips++

          // Delete old versions if exist
          if (remote) {
            await this.deleteClipFiles(clip.id, remote.timestamp, remoteFiles)
          }
        } catch (error) {
          result.errors.push(`Failed to upload clip ${clip.id}: ${error}`)
        }
      }
    }

    // Download remote clips that are newer or don't exist locally
    for (const [clipId, remote] of remoteByClipId) {
      const localClip = localClips.find(c => c.id === clipId)

      if (!localClip || remote.timestamp > localClip.updated_at) {
        try {
          await this.downloadClip(remote.file, remote.timestamp, remoteFiles)
          result.downloaded.clips++
        } catch (error) {
          result.errors.push(`Failed to download clip ${clipId}: ${error}`)
        }
      }
    }

    // Delete clips from Drive that no longer exist locally
    for (const [clipId] of remoteByClipId) {
      if (!localClipIds.has(clipId)) {
        try {
          const filesToDelete = remoteFiles.filter(f => {
            const parsed = parseFilename(f.name)
            return parsed && parsed.type === 'clip' && parsed.id === clipId
          })

          for (const file of filesToDelete) {
            await googleDriveService.deleteFile(file.id)
          }
          result.deleted.clips++
        } catch (error) {
          result.errors.push(`Failed to delete clip ${clipId} from Drive: ${error}`)
        }
      }
    }

    // Clean up old versions
    await this.cleanupOldVersions(remoteFiles, 'clip')
  }

  private async uploadClip(clip: Clip): Promise<void> {
    const backup: ClipBackup = {
      id: clip.id,
      source_id: clip.source_id,
      start: clip.start,
      duration: clip.duration,
      note: clip.note,
      transcription: clip.transcription,
      created_at: clip.created_at,
      updated_at: clip.updated_at,
    }

    const timestamp = clip.updated_at
    const jsonFilename = `clip_${clip.id}_${timestamp}.json`
    const mp3Filename = `clip_${clip.id}_${timestamp}.mp3`

    // Upload JSON
    const jsonContent = JSON.stringify(backup, null, 2)
    await googleDriveService.uploadFile('clips', jsonFilename, jsonContent)

    // Upload MP3
    const clipPath = clip.uri.replace('file://', '')
    const mp3Content = await RNFS.readFile(clipPath, 'base64')
    const mp3Bytes = base64ToUint8Array(mp3Content)
    await googleDriveService.uploadFile('clips', mp3Filename, mp3Bytes)

    console.log(`Uploaded clip: ${clip.id}`)
  }

  private async downloadClip(
    jsonFile: DriveFile,
    timestamp: number,
    allFiles: DriveFile[]
  ): Promise<void> {
    // Download JSON
    const jsonContent = await googleDriveService.downloadFile(jsonFile.id, false) as string
    const backup: ClipBackup = JSON.parse(jsonContent)

    // Find and download MP3
    const mp3Filename = `clip_${backup.id}_${timestamp}.mp3`
    const mp3File = allFiles.find(f => f.name === mp3Filename)

    if (!mp3File) {
      throw new Error(`MP3 file not found for clip ${backup.id}`)
    }

    const mp3Bytes = await googleDriveService.downloadFile(mp3File.id, true) as Uint8Array

    // Save MP3 to clips directory
    const clipsDir = `${RNFS.DocumentDirectoryPath}/clips`
    if (!(await RNFS.exists(clipsDir))) {
      await RNFS.mkdir(clipsDir)
    }

    const localMp3Path = `${clipsDir}/${generateClipFilename()}.mp3`
    const mp3Base64 = uint8ArrayToBase64(mp3Bytes)
    await RNFS.writeFile(localMp3Path, mp3Base64, 'base64')

    const localUri = `file://${localMp3Path}`

    // Restore to database
    databaseService.restoreClipFromBackup(
      backup.id,
      backup.source_id,
      localUri,
      backup.start,
      backup.duration,
      backup.note,
      backup.transcription,
      backup.created_at,
      backup.updated_at
    )

    console.log(`Downloaded clip: ${backup.id}`)
  }

  private async deleteClipFiles(
    clipId: string,
    timestamp: number,
    allFiles: DriveFile[]
  ): Promise<void> {
    const filesToDelete = allFiles.filter(f => {
      const parsed = parseFilename(f.name)
      return parsed && parsed.type === 'clip' && parsed.id === clipId && parsed.timestamp === timestamp
    })

    for (const file of filesToDelete) {
      await googleDriveService.deleteFile(file.id)
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private groupByLatest(
    files: DriveFile[],
    type: 'book' | 'clip'
  ): Map<string, { file: DriveFile; timestamp: number }> {
    const grouped = new Map<string, { file: DriveFile; timestamp: number }>()

    for (const file of files) {
      const parsed = parseFilename(file.name)
      if (!parsed || parsed.type !== type || parsed.extension !== 'json') continue

      const existing = grouped.get(parsed.id)
      if (!existing || parsed.timestamp > existing.timestamp) {
        grouped.set(parsed.id, { file, timestamp: parsed.timestamp })
      }
    }

    return grouped
  }

  private async cleanupOldVersions(files: DriveFile[], type: 'book' | 'clip'): Promise<void> {
    // Group all files by ID
    const byId = new Map<string, DriveFile[]>()

    for (const file of files) {
      const parsed = parseFilename(file.name)
      if (!parsed || parsed.type !== type) continue

      const list = byId.get(parsed.id) || []
      list.push(file)
      byId.set(parsed.id, list)
    }

    // For each ID, delete all but the newest
    for (const [id, idFiles] of byId) {
      if (idFiles.length <= 1) continue

      // Sort by timestamp descending
      const sorted = idFiles
        .map(f => ({ file: f, parsed: parseFilename(f.name)! }))
        .sort((a, b) => b.parsed.timestamp - a.parsed.timestamp)

      // Skip the newest, delete the rest
      for (let i = 1; i < sorted.length; i++) {
        try {
          await googleDriveService.deleteFile(sorted[i].file.id)
          console.log(`Cleaned up old version: ${sorted[i].file.name}`)
        } catch (error) {
          console.warn(`Failed to cleanup ${sorted[i].file.name}:`, error)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Filename parsing
// ---------------------------------------------------------------------------

function parseFilename(name: string): ParsedFilename | null {
  const match = name.match(FILENAME_REGEX)
  if (!match) return null

  return {
    type: match[1] as 'book' | 'clip',
    id: match[2],
    timestamp: parseInt(match[3], 10),
    extension: match[4] as 'json' | 'mp3',
  }
}

function generateClipFilename(): string {
  return (Math.random() + 1).toString(36).substring(2)
}

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const backupSyncService = new BackupSyncService()
