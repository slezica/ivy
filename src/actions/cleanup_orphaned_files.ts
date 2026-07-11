import type { DatabaseService, FileStorageService } from '../services'
import type { Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'
import { CLIPS_DIR } from './constants'

export interface CleanupOrphanedFilesDeps {
  db: DatabaseService
  files: FileStorageService
}

// Files younger than this are never deleted: they may belong to in-flight work
// (a clip being sliced, sync writing audio before its DB row exists). Real
// orphans are reclaimed by a later run.
const GRACE_PERIOD_MS = 60 * 60 * 1000

export type CleanupOrphanedFiles = Action<[]>

export const createCleanupOrphanedFiles: ActionFactory<CleanupOrphanedFilesDeps, CleanupOrphanedFiles> = (deps) => (
  async () => {
    const { db, files } = deps

    const knownUris = await db.getAllFileUris()

    const bookFiles = await files.listFiles(files.audioDirectoryPath)
    const clipFiles = await files.listFiles(CLIPS_DIR)

    const candidates = [...bookFiles, ...clipFiles].filter(uri => !knownUris.has(uri))

    const now = Date.now()
    const orphans: string[] = []

    for (const uri of candidates) {
      const mtime = await files.getModificationTime(uri)

      // Skip recent files (or ones we can't stat) — they may be mid-write
      if (mtime === null || now - mtime < GRACE_PERIOD_MS) continue

      orphans.push(uri)
    }

    for (const uri of orphans) {
      await files.deleteFile(uri).catch(() => {})
    }

    if (orphans.length > 0) {
      createLogger('Cleanup')(`Deleted ${orphans.length} orphaned file(s)`)
    }
  }
)
