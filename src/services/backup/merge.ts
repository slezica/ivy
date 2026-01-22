/**
 * Sync Merge Functions
 *
 * Pure functions for merging local and remote entities during sync conflicts.
 * No I/O, no side effects - just data transformation.
 */

import { Book, Clip } from '../storage'
import { BookBackup, ClipBackup } from './types'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface MergeResult<T> {
  merged: T
  resolution: string // Human-readable description of how conflict was resolved
}

// -----------------------------------------------------------------------------
// Book Merge
// -----------------------------------------------------------------------------

/**
 * Merge a local book with a remote backup.
 *
 * Strategy:
 * - hidden: hidden-wins (if either side is hidden, result is hidden)
 * - position: max value wins (user progressed further on one device)
 * - metadata (title, artist, artwork): last-write-wins based on updated_at
 */
export function mergeBook(local: Book, remote: BookBackup): MergeResult<Book> {
  const mergedHidden = local.hidden || (remote.hidden ?? false)
  const mergedPosition = Math.max(local.position, remote.position)
  const localWins = local.updated_at >= remote.updated_at

  const merged: Book = {
    ...local,
    hidden: mergedHidden,
    position: mergedPosition,
    title: localWins ? local.title : remote.title,
    artist: localWins ? local.artist : remote.artist,
    artwork: localWins ? local.artwork : remote.artwork,
    updated_at: Date.now(),
  }

  const hiddenNote = mergedHidden ? ', hidden: true' : ''
  const resolution = `Position: ${mergedPosition}ms (max), metadata: ${localWins ? 'local' : 'remote'} wins${hiddenNote}`

  return { merged, resolution }
}

// -----------------------------------------------------------------------------
// Clip Merge
// -----------------------------------------------------------------------------

/**
 * Merge a local clip with a remote backup.
 *
 * Strategy:
 * - note: concatenate with conflict marker if both have different non-empty notes
 * - start, duration: last-write-wins based on updated_at
 * - transcription: prefer non-null (either side)
 */
export function mergeClip(local: Clip, remote: ClipBackup): MergeResult<Clip> {
  const localWins = local.updated_at >= remote.updated_at

  const mergedNote = mergeNotes(local.note, remote.note)
  const notesConflicted = mergedNote !== local.note && mergedNote !== remote.note

  const merged: Clip = {
    ...local,
    note: mergedNote,
    start: localWins ? local.start : remote.start,
    duration: localWins ? local.duration : remote.duration,
    transcription: local.transcription ?? remote.transcription,
    updated_at: Date.now(),
  }

  const resolution = notesConflicted
    ? 'Notes concatenated with conflict marker'
    : `Bounds: ${localWins ? 'local' : 'remote'} wins`

  return { merged, resolution }
}

/**
 * Merge two notes, concatenating with a conflict marker if they differ.
 */
function mergeNotes(localNote: string, remoteNote: string): string {
  // If same, return as-is
  if (localNote === remoteNote) {
    return localNote
  }

  // If one is empty, use the other
  if (!localNote) return remoteNote
  if (!remoteNote) return localNote

  // Both have content and differ - concatenate with marker
  const timestamp = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  return `${localNote}\n\n--- Conflict (${timestamp}) ---\n${remoteNote}`
}
