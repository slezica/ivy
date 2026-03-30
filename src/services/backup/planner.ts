/**
 * Sync Planner
 *
 * Pure functions that determine what sync operations need to happen.
 * Takes current state, returns a plan. No I/O, no side effects.
 */

import { Book, Clip, Session, SyncManifestEntry } from '../storage'
import { BookBackup, ClipBackup, SessionBackup } from './types'

// -----------------------------------------------------------------------------
// Input: Sync State
// -----------------------------------------------------------------------------

export interface RemoteBook {
  backup: BookBackup
  fileId: string
  modifiedAt: number // Drive's modifiedTime as epoch ms
}

export interface RemoteClip {
  backup: ClipBackup
  jsonFileId: string
  audioFileId: string
  audioFilename: string
  modifiedAt: number
}

export interface RemoteSession {
  backup: SessionBackup
  fileId: string
  modifiedAt: number
}

export interface SyncState {
  local: {
    books: Book[]
    clips: Clip[]
    sessions: Session[]
  }
  remote: {
    books: Map<string, RemoteBook>
    clips: Map<string, RemoteClip>
    sessions: Map<string, RemoteSession>
  }
  manifests: Map<string, SyncManifestEntry> // key: "book:id", "clip:id", or "session:id"
}

// -----------------------------------------------------------------------------
// Output: Sync Plan
// -----------------------------------------------------------------------------

export interface BookUpload {
  book: Book
}

export interface BookDownload {
  remote: RemoteBook
}

export interface BookMerge {
  local: Book
  remote: RemoteBook
}

export interface ClipUpload {
  clip: Clip
}

export interface ClipDownload {
  remote: RemoteClip
}

export interface ClipMerge {
  local: Clip
  remote: RemoteClip
}

export interface ClipDelete {
  clipId: string
  jsonFileId: string | null
  audioFileId: string | null
}

export interface SessionUpload {
  session: Session
}

export interface SessionDownload {
  remote: RemoteSession
}

export interface SessionMerge {
  local: Session
  remote: RemoteSession
}

export interface SessionDelete {
  sessionId: string
  fileId: string | null
}

export interface SyncPlan {
  books: {
    uploads: BookUpload[]
    downloads: BookDownload[]
    merges: BookMerge[]
  }
  clips: {
    uploads: ClipUpload[]
    downloads: ClipDownload[]
    merges: ClipMerge[]
    deletes: ClipDelete[]
  }
  sessions: {
    uploads: SessionUpload[]
    downloads: SessionDownload[]
    merges: SessionMerge[]
    deletes: SessionDelete[]
  }
}

// -----------------------------------------------------------------------------
// Planner
// -----------------------------------------------------------------------------

/**
 * Given current sync state, determine what operations need to happen.
 */
export function planSync(state: SyncState): SyncPlan {
  return {
    books: planBookSync(state),
    clips: planClipSync(state),
    sessions: planSessionSync(state),
  }
}

function planBookSync(state: SyncState): SyncPlan['books'] {
  const uploads: BookUpload[] = []
  const downloads: BookDownload[] = []
  const merges: BookMerge[] = []

  const localBooksMap = new Map(state.local.books.map(b => [b.id, b]))

  // PUSH: Check each local book for uploads/merges
  for (const book of state.local.books) {
    const manifest = state.manifests.get(`book:${book.id}`)
    const remote = state.remote.books.get(book.id)

    if (!manifest) {
      // New locally → upload
      uploads.push({ book })
    } else if (book.updated_at > (manifest.local_updated_at ?? 0)) {
      // Changed locally since last sync
      if (remote && hasRemoteChanged(remote.modifiedAt, manifest)) {
        // Both changed → merge
        merges.push({ local: book, remote })
      } else {
        // Only local changed → upload
        uploads.push({ book })
      }
    }
  }

  // PULL: Check each remote book for downloads
  for (const [bookId, remote] of state.remote.books) {
    const manifest = state.manifests.get(`book:${bookId}`)
    const localBook = localBooksMap.get(bookId)

    if (!manifest) {
      // New remotely → download
      downloads.push({ remote })
    } else if (hasRemoteChanged(remote.modifiedAt, manifest)) {
      // Changed remotely since last sync
      if (!localBook || localBook.updated_at <= (manifest.local_updated_at ?? 0)) {
        // Not changed locally → download
        downloads.push({ remote })
      }
      // If both changed, it's handled as a merge in push phase
    }
  }

  return { uploads, downloads, merges }
}

function planClipSync(state: SyncState): SyncPlan['clips'] {
  const uploads: ClipUpload[] = []
  const downloads: ClipDownload[] = []
  const merges: ClipMerge[] = []
  const deletes: ClipDelete[] = []

  const localClipsMap = new Map(state.local.clips.map(c => [c.id, c]))
  const localClipIds = new Set(state.local.clips.map(c => c.id))

  // PUSH: Check each local clip for uploads/merges
  for (const clip of state.local.clips) {
    const manifest = state.manifests.get(`clip:${clip.id}`)
    const remote = state.remote.clips.get(clip.id)

    if (!manifest) {
      // New locally → upload
      uploads.push({ clip })
    } else if (clip.updated_at > (manifest.local_updated_at ?? 0)) {
      // Changed locally since last sync
      if (remote && hasRemoteChanged(remote.modifiedAt, manifest)) {
        // Both changed → merge
        merges.push({ local: clip, remote })
      } else {
        // Only local changed → upload
        uploads.push({ clip })
      }
    }
  }

  // PULL: Check each remote clip for downloads
  for (const [clipId, remote] of state.remote.clips) {
    const manifest = state.manifests.get(`clip:${clipId}`)
    const localClip = localClipsMap.get(clipId)

    if (!manifest) {
      // New remotely → download
      downloads.push({ remote })
    } else if (!localClip) {
      // Had manifest but deleted locally → skip (DELETE pass handles it)
    } else if (hasRemoteChanged(remote.modifiedAt, manifest)) {
      // Changed remotely since last sync
      if (localClip.updated_at <= (manifest.local_updated_at ?? 0)) {
        // Not changed locally → download
        downloads.push({ remote })
      }
      // If both changed, it's handled as a merge in push phase
    }
  }

  // DELETE: Remote clips that were deleted locally
  for (const [clipId, remote] of state.remote.clips) {
    const manifest = state.manifests.get(`clip:${clipId}`)
    // If we have a manifest (we knew about it) but no local clip, it was deleted
    if (manifest && !localClipIds.has(clipId)) {
      deletes.push({
        clipId,
        jsonFileId: remote.jsonFileId,
        audioFileId: remote.audioFileId,
      })
    }
  }

  return { uploads, downloads, merges, deletes }
}

function planSessionSync(state: SyncState): SyncPlan['sessions'] {
  const uploads: SessionUpload[] = []
  const downloads: SessionDownload[] = []
  const merges: SessionMerge[] = []
  const deletes: SessionDelete[] = []

  const localSessionsMap = new Map(state.local.sessions.map(s => [s.id, s]))
  const localSessionIds = new Set(state.local.sessions.map(s => s.id))

  // PUSH: Check each local session for uploads/merges
  for (const session of state.local.sessions) {
    const manifest = state.manifests.get(`session:${session.id}`)
    const remote = state.remote.sessions.get(session.id)

    if (!manifest) {
      uploads.push({ session })
    } else if (session.updated_at > (manifest.local_updated_at ?? 0)) {
      if (remote && hasRemoteChanged(remote.modifiedAt, manifest)) {
        merges.push({ local: session, remote })
      } else {
        uploads.push({ session })
      }
    }
  }

  // PULL: Check each remote session for downloads
  for (const [sessionId, remote] of state.remote.sessions) {
    const manifest = state.manifests.get(`session:${sessionId}`)
    const localSession = localSessionsMap.get(sessionId)

    if (!manifest) {
      downloads.push({ remote })
    } else if (!localSession) {
      // Had manifest but deleted locally → skip (DELETE pass handles it)
    } else if (hasRemoteChanged(remote.modifiedAt, manifest)) {
      if (localSession.updated_at <= (manifest.local_updated_at ?? 0)) {
        downloads.push({ remote })
      }
    }
  }

  // DELETE: Remote sessions that were deleted locally
  for (const [sessionId, remote] of state.remote.sessions) {
    const manifest = state.manifests.get(`session:${sessionId}`)
    if (manifest && !localSessionIds.has(sessionId)) {
      deletes.push({
        sessionId,
        fileId: remote.fileId,
      })
    }
  }

  return { uploads, downloads, merges, deletes }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function hasRemoteChanged(remoteModifiedAt: number, manifest: SyncManifestEntry): boolean {
  return remoteModifiedAt > (manifest.remote_updated_at ?? 0)
}
