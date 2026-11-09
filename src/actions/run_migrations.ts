import type { DatabaseService, AudioMetadataService, ArtworkStore } from '../services'
import type { Action, ActionFactory } from '../store/types'

export interface RunMigrationsDeps {
  db: DatabaseService
  metadata: AudioMetadataService
  artworkStore: ArtworkStore
}

export type RunMigrations = Action<[]>

// Applies pending database migrations. Must complete before anything else
// touches the database — initializeApplication runs it first.
export const createRunMigrations: ActionFactory<RunMigrationsDeps, RunMigrations> = (deps) => (
  async () => {
    await deps.db.migrate({ metadata: deps.metadata, artwork: deps.artworkStore })
  }
)
