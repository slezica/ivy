/**
 * Sync Planner
 *
 * Pure functions that determine what sync operations need to happen.
 * Takes current state, returns a plan. No I/O, no side effects.
 */

import { Book, Clip, SyncManifestEntry } from '../storage'
import { BookBackup, ClipBackup } from './types'

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
  mp3FileId: string
  modifiedAt: number
}

export interface SyncState {
  local: {
    books: Book[]
    clips: Clip[]
  }
  remote: {
    books: Map<string, RemoteBook>
    clips: Map<string, RemoteClip>
  }
  manifests: Map<string, SyncManifestEntry> // key: "book:id" or "clip:id"
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
  mp3FileId: string | null
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
  }
}

function planBookSync(state: SyncState): SyncPlan['books'] {
  const uploads: BookUpload[] = []
  const downloads: BookDownload[] = []
  const merges: BookMerge[] = []

  const localBooksMap = new Map(state.local.books.map(b => [b.id, b]))
  const processedIds = new Set<string>()

  // PUSH: Check each local book
  for (const book of state.local.books) {
    const manifest = state.manifests.get(`book:${book.id}`)
    const remote = state.remote.books.get(book.id)

    processedIds.add(book.id)

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

  // PULL: Check each remote book
  for (const [bookId, remote] of state.remote.books) {
    if (processedIds.has(bookId)) continue // Already handled in push phase

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
      // If both changed, conflict was handled in push phase
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
  const processedIds = new Set<string>()

  // PUSH: Check each local clip
  for (const clip of state.local.clips) {
    const manifest = state.manifests.get(`clip:${clip.id}`)
    const remote = state.remote.clips.get(clip.id)

    processedIds.add(clip.id)

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

  // PULL: Check each remote clip
  for (const [clipId, remote] of state.remote.clips) {
    if (processedIds.has(clipId)) continue // Already handled in push phase

    const manifest = state.manifests.get(`clip:${clipId}`)
    const localClip = localClipsMap.get(clipId)

    if (!manifest) {
      // New remotely → download
      downloads.push({ remote })
    } else if (hasRemoteChanged(remote.modifiedAt, manifest)) {
      // Changed remotely since last sync
      if (!localClip || localClip.updated_at <= (manifest.local_updated_at ?? 0)) {
        // Not changed locally → download
        downloads.push({ remote })
      }
      // If both changed, conflict was handled in push phase
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
        mp3FileId: remote.mp3FileId,
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
