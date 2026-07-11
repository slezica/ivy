/**
 * Google Drive Service
 *
 * REST wrapper for Google Drive API v3.
 * Manages files in a public Ivy/ folder structure.
 */

import { GoogleAuthService } from './auth'
import { createLogger } from '../../utils'

const log = createLogger('GoogleDrive')

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'

const ROOT_FOLDER_NAME = 'Ivy'
const FOLDERS = {
  books: 'books',
  clips: 'clips',
  sessions: 'sessions',
} as const

export type BackupFolder = keyof typeof FOLDERS

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string  // ISO 8601 timestamp from Drive
  md5Checksum?: string   // Content hash (binary-content files; absent for Google Docs types)
  trashed?: boolean      // In the user's trash (change feed only; listFiles filters trashed)
}

/** Drive REST error carrying the HTTP status, for callers that branch on it (e.g. 404). */
export class DriveApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'DriveApiError'
    this.status = status
  }
}

export class GoogleDriveService {
  private auth: GoogleAuthService
  private rootFolderId: string | null = null
  private folderIds: Record<BackupFolder, string | null> = {
    books: null,
    clips: null,
    sessions: null,
  }
  // Track in-flight folder creation to prevent duplicate folders from concurrent requests
  private folderPromises: Record<string, Promise<string> | null> = {}

  constructor(auth: GoogleAuthService) {
    this.auth = auth
  }

  /**
   * List all files in a backup folder.
   * Handles pagination to return all files (Drive API returns max 1000 per page).
   */
  async listFiles(folder: BackupFolder): Promise<DriveFile[]> {
    const folderId = await this.ensureFolder(folder)
    const token = await this.getToken()

    const query = `'${folderId}' in parents and trashed = false`
    const fields = 'nextPageToken, files(id, name, mimeType, modifiedTime, md5Checksum)'
    const allFiles: DriveFile[] = []
    let pageToken: string | undefined

    do {
      const params = new URLSearchParams({
        q: query,
        fields,
        pageSize: '1000',
      })
      if (pageToken) params.set('pageToken', pageToken)

      const response = await fetch(`${DRIVE_API}/files?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        throw new Error(`Failed to list files: ${response.status}`)
      }

      const data = await response.json()
      allFiles.push(...(data.files || []))
      pageToken = data.nextPageToken
    } while (pageToken)

    return allFiles
  }

  /**
   * Upload a file to a backup folder.
   * Content can be string (JSON) or Uint8Array (binary).
   * Uses simple upload for JSON, resumable for binary.
   */
  async uploadFile(
    folder: BackupFolder,
    name: string,
    content: string | Uint8Array
  ): Promise<DriveFile> {
    const folderId = await this.ensureFolder(folder)
    const token = await this.getToken()

    const isJson = typeof content === 'string'
    const mimeType = isJson ? 'application/json' : 'audio/mp4'

    // Step 1: Create file with metadata, get upload URI
    const metadata = {
      name,
      parents: [folderId],
    }

    const fields = 'id,name,mimeType,modifiedTime,md5Checksum'
    const initResponse = await fetch(`${UPLOAD_API}/files?uploadType=resumable&fields=${encodeURIComponent(fields)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': mimeType,
      },
      body: JSON.stringify(metadata),
    })

    if (!initResponse.ok) {
      const errorText = await initResponse.text()
      throw new Error(`Failed to init upload: ${initResponse.status} - ${errorText}`)
    }

    const uploadUri = initResponse.headers.get('Location')
    if (!uploadUri) {
      throw new Error('No upload URI returned')
    }

    // Step 2: Upload content
    const uploadResponse = await fetch(uploadUri, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
      },
      body: isJson ? content : (content as Uint8Array).buffer as ArrayBuffer,
    })

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text()
      throw new Error(`Failed to upload content: ${uploadResponse.status} - ${errorText}`)
    }

    const data = await uploadResponse.json()
    return {
      id: data.id,
      name: data.name,
      mimeType: data.mimeType,
      modifiedTime: data.modifiedTime,
      md5Checksum: data.md5Checksum,
    }
  }

  /**
   * Download a file by ID.
   * Returns string for JSON, Uint8Array for binary.
   */
  async downloadFile(fileId: string, isBinary: boolean = false): Promise<string | Uint8Array> {
    const token = await this.getToken()
    const url = `${DRIVE_API}/files/${fileId}?alt=media`

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!response.ok) {
      throw new DriveApiError(`Failed to download file: ${response.status}`, response.status)
    }

    if (isBinary) {
      const buffer = await response.arrayBuffer()
      return new Uint8Array(buffer)
    }

    return response.text()
  }

  /**
   * Delete a file by ID.
   */
  async deleteFile(fileId: string): Promise<void> {
    const token = await this.getToken()
    const url = `${DRIVE_API}/files/${fileId}`

    const response = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!response.ok && response.status !== 404) {
      throw new DriveApiError(`Failed to delete file: ${response.status}`, response.status)
    }
  }

  // ---------------------------------------------------------------------------
  // Changes API (for incremental sync)
  // ---------------------------------------------------------------------------

  /**
   * Get a page token representing the current state.
   * Future calls to getChanges() with this token will return only changes after this point.
   */
  async getStartPageToken(): Promise<string> {
    const token = await this.getToken()

    const response = await fetch(`${DRIVE_API}/changes/startPageToken`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Failed to get start page token: ${response.status} - ${text}`)
    }

    const data = await response.json()
    return data.startPageToken
  }

  /**
   * Get changes since a given page token.
   * Returns changed files and a new page token to use next time.
   */
  async getChanges(pageToken: string): Promise<{
    changes: Array<{
      fileId: string
      removed: boolean
      file?: DriveFile
    }>
    newStartPageToken?: string
    nextPageToken?: string
  }> {
    const token = await this.getToken()

    const allChanges: Array<{ fileId: string; removed: boolean; file?: DriveFile }> = []
    let currentToken = pageToken
    let newStartPageToken: string | undefined

    do {
      const params = new URLSearchParams({
        pageToken: currentToken,
        fields: 'nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, modifiedTime, md5Checksum, trashed))',
        spaces: 'drive',
        pageSize: '100',
      })

      const response = await fetch(`${DRIVE_API}/changes?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        const text = await response.text()
        throw new DriveApiError(`Failed to get changes: ${response.status} - ${text}`, response.status)
      }

      const data = await response.json()

      for (const change of data.changes ?? []) {
        allChanges.push({
          fileId: change.fileId,
          removed: change.removed ?? false,
          file: change.file ? {
            id: change.file.id,
            name: change.file.name,
            mimeType: change.file.mimeType,
            modifiedTime: change.file.modifiedTime,
            md5Checksum: change.file.md5Checksum,
            trashed: change.file.trashed,
          } : undefined,
        })
      }

      if (data.newStartPageToken) {
        newStartPageToken = data.newStartPageToken
      }

      currentToken = data.nextPageToken
    } while (currentToken)

    return { changes: allChanges, newStartPageToken }
  }

  /**
   * Update an existing file's content in place (preserves file ID).
   */
  async updateFile(
    fileId: string,
    content: string | Uint8Array
  ): Promise<DriveFile> {
    const token = await this.getToken()

    const isJson = typeof content === 'string'
    const mimeType = isJson ? 'application/json' : 'audio/mp4'

    const fields = 'id,name,mimeType,modifiedTime,md5Checksum'
    const initResponse = await fetch(`${UPLOAD_API}/files/${fileId}?uploadType=resumable&fields=${encodeURIComponent(fields)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': mimeType,
      },
      body: JSON.stringify({}),
    })

    if (!initResponse.ok) {
      const errorText = await initResponse.text()
      throw new DriveApiError(`Failed to init update: ${initResponse.status} - ${errorText}`, initResponse.status)
    }

    const uploadUri = initResponse.headers.get('Location')
    if (!uploadUri) {
      throw new Error('No upload URI returned')
    }

    const uploadResponse = await fetch(uploadUri, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: isJson ? content : (content as Uint8Array).buffer as ArrayBuffer,
    })

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text()
      throw new DriveApiError(`Failed to upload update: ${uploadResponse.status} - ${errorText}`, uploadResponse.status)
    }

    const data = await uploadResponse.json()
    return {
      id: data.id,
      name: data.name,
      mimeType: data.mimeType,
      modifiedTime: data.modifiedTime,
      md5Checksum: data.md5Checksum,
    }
  }

  /**
   * Reset cached folder IDs (useful after sign-out).
   */
  resetCache(): void {
    this.rootFolderId = null
    this.folderIds = { books: null, clips: null, sessions: null }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async getToken(): Promise<string> {
    const token = await this.auth.getAccessToken()
    if (!token) {
      throw new Error('Not authenticated with Google')
    }
    return token
  }

  private async ensureFolder(folder: BackupFolder): Promise<string> {
    // Return cached ID if available
    if (this.folderIds[folder]) {
      return this.folderIds[folder]!
    }

    // If a request for this folder is already in flight, wait for it
    const cacheKey = `folder:${folder}`
    if (this.folderPromises[cacheKey]) {
      return this.folderPromises[cacheKey]!
    }

    // Start folder creation and track the promise
    this.folderPromises[cacheKey] = this.createFolderStructure(folder)

    try {
      const folderId = await this.folderPromises[cacheKey]!
      return folderId
    } finally {
      this.folderPromises[cacheKey] = null
    }
  }

  private async createFolderStructure(folder: BackupFolder): Promise<string> {
    const folderName = FOLDERS[folder]
    if (!folderName) {
      throw new Error(`Unknown backup folder: ${String(folder)}`)
    }

    // Ensure root folder exists (with its own lock)
    if (!this.rootFolderId) {
      const rootKey = 'folder:root'
      if (!this.folderPromises[rootKey]) {
        this.folderPromises[rootKey] = this.findOrCreateFolder(ROOT_FOLDER_NAME, 'root')
      }
      this.rootFolderId = await this.folderPromises[rootKey]!
      this.folderPromises[rootKey] = null
    }

    // Create subfolder
    this.folderIds[folder] = await this.findOrCreateFolder(
      folderName,
      this.rootFolderId
    )

    return this.folderIds[folder]!
  }

  private async findOrCreateFolder(name: string, parentId: string): Promise<string> {
    const token = await this.getToken()

    // Search for existing folder(s)
    const existing = await this.searchFolders(name, parentId, token)
    if (existing.length > 0) {
      log(`Found existing folder: ${name}`)
      return pickOldestFolder(existing)
    }

    // Create folder
    const metadata = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }

    const createResponse = await fetch(`${DRIVE_API}/files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(metadata),
    })

    if (!createResponse.ok) {
      throw new Error(`Failed to create folder: ${createResponse.status}`)
    }

    const createData = await createResponse.json()
    log(`Created folder: ${name}`)

    // Re-query: another device may have created the same folder concurrently.
    // Every device adopts the oldest copy so the trees converge; no Drive-side
    // cleanup is attempted (stray empty folders are harmless).
    const folders = await this.searchFolders(name, parentId, token)
    if (folders.length > 1) {
      const adopted = pickOldestFolder(folders)
      log(`Duplicate '${name}' folders detected — adopting oldest: ${adopted}`)
      return adopted
    }

    return folders[0]?.id ?? createData.id
  }

  private async searchFolders(name: string, parentId: string, token: string): Promise<FolderInfo[]> {
    const parentQuery = parentId === 'root' ? `'root' in parents` : `'${parentId}' in parents`
    const query = `name = '${name}' and ${parentQuery} and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    const searchUrl = `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id, createdTime)`

    const searchResponse = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!searchResponse.ok) {
      throw new Error(`Failed to search for folder: ${searchResponse.status}`)
    }

    const searchData = await searchResponse.json()
    return searchData.files ?? []
  }
}

interface FolderInfo {
  id: string
  createdTime?: string
}

/** Deterministic duplicate-folder resolution: oldest createdTime, id tie-break. */
function pickOldestFolder(folders: FolderInfo[]): string {
  const sorted = [...folders].sort((a, b) => {
    const aTime = a.createdTime ?? ''
    const bTime = b.createdTime ?? ''
    if (aTime !== bTime) return aTime < bTime ? -1 : 1
    return a.id < b.id ? -1 : 1
  })
  return sorted[0].id
}
