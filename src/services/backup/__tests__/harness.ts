/**
 * Sync engine scenario harness
 *
 * Runs the real BackupSyncService against a scripted in-memory fake of the
 * GoogleDriveService surface plus the real DatabaseService on real SQLite,
 * so scenarios exercise actual SQL constraints and the actual sync engine.
 */

import { DatabaseService } from '../../storage'
import { createTestDatabase } from '../../storage/__tests__/sqlite_adapter'
import { BackupSyncService } from '../sync'
import type { GoogleDriveService, DriveFile, BackupFolder } from '../drive'
import type { GoogleAuthService } from '../auth'

// -----------------------------------------------------------------------------
// Fake Drive
// -----------------------------------------------------------------------------

export interface FakeDriveFile {
  id: string
  folder: BackupFolder
  name: string
  mimeType: string
  content: string | Uint8Array
  trashed: boolean
}

type FakeDriveMethod =
  | 'listFiles'
  | 'uploadFile'
  | 'updateFile'
  | 'downloadFile'
  | 'deleteFile'
  | 'getChanges'
  | 'getStartPageToken'

/**
 * In-memory Google Drive: file store + change feed, with failure injection.
 * Page tokens are stringified sequence numbers into the change log.
 */
export class FakeDrive {
  files = new Map<string, FakeDriveFile>()

  private changeLog: Array<{ seq: number; fileId: string; removed: boolean }> = []
  private nextSeq = 1
  private nextFileId = 1
  private failures = new Map<FakeDriveMethod, Error[]>()

  // -- Test controls ------------------------------------------------------

  /** Make the next `times` calls to a method throw the given error. */
  failNext(method: FakeDriveMethod, error: Error, times: number = 1): void {
    const queue = this.failures.get(method) ?? []
    for (let i = 0; i < times; i++) queue.push(error)
    this.failures.set(method, queue)
  }

  /** Seed a remote file directly, recording a change feed entry. */
  putFile(folder: BackupFolder, name: string, content: string | Uint8Array): string {
    const id = `drive-${this.nextFileId++}`
    const mimeType = typeof content === 'string' ? 'application/json' : 'audio/mp4'
    this.files.set(id, { id, folder, name, mimeType, content, trashed: false })
    this.recordChange(id, false)
    return id
  }

  /** Mark a file trashed (stays in the store, emits a feed entry). */
  trashFile(fileId: string): void {
    const file = this.files.get(fileId)
    if (!file) throw new Error(`FakeDrive: no file ${fileId}`)
    file.trashed = true
    this.recordChange(fileId, false)
  }

  /** Permanently remove a file (emits a `removed` feed entry, no metadata). */
  removeFile(fileId: string): void {
    this.files.delete(fileId)
    this.recordChange(fileId, true)
  }

  getFileByName(name: string): FakeDriveFile | undefined {
    return [...this.files.values()].find(f => f.name === name)
  }

  readJson(name: string): any {
    const file = this.getFileByName(name)
    if (!file || typeof file.content !== 'string') return null
    return JSON.parse(file.content)
  }

  asDriveService(): GoogleDriveService {
    return this as unknown as GoogleDriveService
  }

  // -- GoogleDriveService surface (as used by sync.ts) ----------------------

  async listFiles(folder: BackupFolder): Promise<DriveFile[]> {
    this.maybeFail('listFiles')
    return [...this.files.values()]
      .filter(f => f.folder === folder && !f.trashed)
      .map(toDriveFile)
  }

  async uploadFile(folder: BackupFolder, name: string, content: string | Uint8Array): Promise<DriveFile> {
    this.maybeFail('uploadFile')
    const id = this.putFile(folder, name, content)
    return toDriveFile(this.files.get(id)!)
  }

  async updateFile(fileId: string, content: string | Uint8Array): Promise<DriveFile> {
    this.maybeFail('updateFile')
    const file = this.files.get(fileId)
    if (!file) throw new Error('Failed to init update: 404 - File not found')
    file.content = content
    this.recordChange(fileId, false)
    return toDriveFile(file)
  }

  async downloadFile(fileId: string, isBinary: boolean = false): Promise<string | Uint8Array> {
    this.maybeFail('downloadFile')
    const file = this.files.get(fileId)
    if (!file) throw new Error('Failed to download file: 404')
    if (isBinary) {
      return typeof file.content === 'string'
        ? new TextEncoder().encode(file.content)
        : file.content
    }
    return file.content as string
  }

  async deleteFile(fileId: string): Promise<void> {
    this.maybeFail('deleteFile')
    // Mirrors the real service: deleting a missing file (404) is a no-op
    if (this.files.has(fileId)) {
      this.removeFile(fileId)
    }
  }

  async getStartPageToken(): Promise<string> {
    this.maybeFail('getStartPageToken')
    return String(this.nextSeq)
  }

  async getChanges(pageToken: string): Promise<{
    changes: Array<{ fileId: string; removed: boolean; file?: DriveFile }>
    newStartPageToken?: string
  }> {
    this.maybeFail('getChanges')
    const since = parseInt(pageToken, 10)
    const changes = this.changeLog
      .filter(c => c.seq >= since)
      .map(c => {
        const file = this.files.get(c.fileId)
        return {
          fileId: c.fileId,
          removed: c.removed,
          // Removed changes carry no metadata, like the real feed
          file: c.removed || !file ? undefined : toDriveFile(file),
        }
      })
    return { changes, newStartPageToken: String(this.nextSeq) }
  }

  // -- Private --------------------------------------------------------------

  private maybeFail(method: FakeDriveMethod): void {
    const error = this.failures.get(method)?.shift()
    if (error) throw error
  }

  private recordChange(fileId: string, removed: boolean): void {
    this.changeLog.push({ seq: this.nextSeq++, fileId, removed })
  }
}

function toDriveFile(file: FakeDriveFile): DriveFile {
  return { id: file.id, name: file.name, mimeType: file.mimeType }
}

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

export function createFakeAuth(): GoogleAuthService {
  return {
    initialize: async () => {},
    isAuthenticated: () => true,
    signIn: async () => true,
    getAccessToken: async () => 'test-token',
  } as unknown as GoogleAuthService
}

export interface SyncHarness {
  db: DatabaseService
  drive: FakeDrive
  sync: BackupSyncService
}

/**
 * A simulated device: real DatabaseService (real SQLite) + real
 * BackupSyncService against the given fake Drive. Pass the same FakeDrive to
 * multiple harnesses to simulate multi-device sync.
 */
export function createSyncHarness(drive: FakeDrive = new FakeDrive()): SyncHarness {
  const db = new DatabaseService(createTestDatabase())
  const sync = new BackupSyncService(db, drive.asDriveService(), createFakeAuth())
  return { db, drive, sync }
}
