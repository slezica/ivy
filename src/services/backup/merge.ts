/**
 * Sync Merge Functions
 *
 * Pure functions for merging local and remote entities during sync conflicts.
 * No I/O, no side effects - just data transformation.
 *
 * Version comparison uses (updated_at, updated_by) where updated_by is a
 * deterministic tie-breaker when timestamps match.
 */

import { Book, Clip, Session } from '../storage'
import { BookBackup, ClipBackup, SessionBackup } from './types'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface MergeResult<T> {
  merged: T
  resolution: string // Human-readable description of how conflict was resolved
}

// -----------------------------------------------------------------------------
// Version Comparison
// -----------------------------------------------------------------------------

/**
 * Determine which side "wins" for last-writer-wins fields.
 * Returns true if local wins, false if remote wins.
 *
 * Primary: higher updated_at wins.
 * Tie-breaker: lexicographically larger updated_by wins.
 */
function localWins(
  localUpdatedAt: number,
  localUpdatedBy: string | null,
  remoteUpdatedAt: number,
  remoteUpdatedBy: string | null,
): boolean {
  if (localUpdatedAt !== remoteUpdatedAt) {
    return localUpdatedAt > remoteUpdatedAt
  }
  // Tie-break: larger device ID wins. Null sorts lower than any string.
  return (localUpdatedBy ?? '') >= (remoteUpdatedBy ?? '')
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
 * - metadata (title, artist, artwork, speed): last-writer-wins
 */
export function mergeBook(local: Book, remote: BookBackup): MergeResult<Book> {
  const mergedHidden = local.hidden || (remote.hidden ?? false)
  const mergedPosition = Math.max(local.position, remote.position)
  const lww = localWins(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)

  const merged: Book = {
    ...local,
    hidden: mergedHidden,
    position: mergedPosition,
    title: lww ? local.title : remote.title,
    artist: lww ? local.artist : remote.artist,
    artwork: lww ? local.artwork : remote.artwork,
    speed: lww ? local.speed : (remote.speed ?? local.speed),
    updated_at: Date.now(),
    updated_by: lww ? local.updated_by : remote.updated_by,
  }

  const hiddenNote = mergedHidden ? ', hidden: true' : ''
  const resolution = `Position: ${mergedPosition}ms (max), metadata: ${lww ? 'local' : 'remote'} wins${hiddenNote}`

  return { merged, resolution }
}

// -----------------------------------------------------------------------------
// Clip Merge
// -----------------------------------------------------------------------------

/**
 * Merge a local clip with a remote backup.
 *
 * Strategy:
 * - note: last-writer-wins
 * - start, duration: last-writer-wins
 * - transcription: prefer non-null; if both non-null, last-writer-wins
 */
export function mergeClip(local: Clip, remote: ClipBackup): MergeResult<Clip> {
  const lww = localWins(local.updated_at, local.updated_by, remote.updated_at, remote.updated_by)

  // Transcription: prefer non-null, then LWW
  let mergedTranscription: string | null
  if (local.transcription && !remote.transcription) {
    mergedTranscription = local.transcription
  } else if (!local.transcription && remote.transcription) {
    mergedTranscription = remote.transcription
  } else {
    mergedTranscription = lww ? local.transcription : remote.transcription
  }

  const merged: Clip = {
    ...local,
    note: lww ? local.note : remote.note,
    start: lww ? local.start : remote.start,
    duration: lww ? local.duration : remote.duration,
    transcription: mergedTranscription,
    updated_at: Date.now(),
    updated_by: lww ? local.updated_by : remote.updated_by,
  }

  const resolution = `All fields: ${lww ? 'local' : 'remote'} wins (LWW)`

  return { merged, resolution }
}

// -----------------------------------------------------------------------------
// Session Merge
// -----------------------------------------------------------------------------

/**
 * Merge a local session with a remote backup.
 *
 * Strategy:
 * - started_at: min (earlier boundary wins)
 * - ended_at: max (longer session wins)
 */
export function mergeSession(local: Session, remote: SessionBackup): MergeResult<Session> {
  const mergedStartedAt = Math.min(local.started_at, remote.started_at)
  const mergedEndedAt = Math.max(local.ended_at, remote.ended_at)

  const merged: Session = {
    ...local,
    started_at: mergedStartedAt,
    ended_at: mergedEndedAt,
    updated_at: Math.max(local.updated_at, remote.updated_at),
    updated_by: local.updated_at >= remote.updated_at ? local.updated_by : remote.updated_by,
  }

  const resolution = `Time range: ${mergedStartedAt}–${mergedEndedAt} (min start, max end)`

  return { merged, resolution }
}
