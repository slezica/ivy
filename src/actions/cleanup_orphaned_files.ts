import type { DatabaseService, FileStorageService } from '../services'
import type { Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'
import { CLIPS_DIR } from './constants'

export interface CleanupOrphanedFilesDeps {
  db: DatabaseService
  files: FileStorageService
}

export type CleanupOrphanedFiles = Action<[]>

export const createCleanupOrphanedFiles: ActionFactory<CleanupOrphanedFilesDeps, CleanupOrphanedFiles> = (deps) => (
  async () => {
    const { db, files } = deps

    const knownUris = await db.getAllFileUris()

    const bookFiles = await files.listFiles(files.audioDirectoryPath)
    const clipFiles = await files.listFiles(CLIPS_DIR)

    const orphans = [...bookFiles, ...clipFiles].filter(uri => !knownUris.has(uri))

    for (const uri of orphans) {
      await files.deleteFile(uri).catch(() => {})
    }

    if (orphans.length > 0) {
      createLogger('Cleanup')(`Deleted ${orphans.length} orphaned file(s)`)
    }
  }
)
