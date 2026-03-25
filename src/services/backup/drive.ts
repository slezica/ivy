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
} as const

export type BackupFolder = keyof typeof FOLDERS

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string  // ISO 8601 timestamp from Drive
}

export class GoogleDriveService {
  private auth: GoogleAuthService
  private rootFolderId: string | null = null
  private folderIds: Record<BackupFolder, string | null> = {
    books: null,
    clips: null,
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
    const fields = 'nextPageToken, files(id, name, mimeType, modifiedTime)'
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
    const mimeType = isJson ? 'application/json' : 'audio/mpeg'

    // Step 1: Create file with metadata, get upload URI
    const metadata = {
      name,
      parents: [folderId],
    }

    const fields = 'id,name,mimeType,modifiedTime'
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
      throw new Error(`Failed to download file: ${response.status}`)
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
      throw new Error(`Failed to delete file: ${response.status}`)
    }
  }

  /**
   * Reset cached folder IDs (useful after sign-out).
   */
  resetCache(): void {
    this.rootFolderId = null
    this.folderIds = { books: null, clips: null }
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
      FOLDERS[folder],
      this.rootFolderId
    )

    return this.folderIds[folder]!
  }

  private async findOrCreateFolder(name: string, parentId: string): Promise<string> {
    const token = await this.getToken()

    // Search for existing folder
    const parentQuery = parentId === 'root' ? `'root' in parents` : `'${parentId}' in parents`
    const query = `name = '${name}' and ${parentQuery} and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    const searchUrl = `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id)`

    const searchResponse = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!searchResponse.ok) {
      throw new Error(`Failed to search for folder: ${searchResponse.status}`)
    }

    const searchData = await searchResponse.json()
    if (searchData.files?.length > 0) {
      log(`Found existing folder: ${name}`)
      return searchData.files[0].id
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
    return createData.id
  }
}

