import type { DatabaseService, FFmetadataService, SyncQueueService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'
// Direct module import: the services barrel instantiates every service on
// load, which actions (and their tests) must not trigger
import { extrasFromTags, fillMissingExtras, EXTRACTED_METADATA_VERSION } from '../services/audio/ffmetadata'
import { createLogger } from '../utils'


export interface ExtractBookExtrasDeps {
  db: DatabaseService
  ffmetadata: FFmetadataService
  syncQueue: SyncQueueService
  set: SetState
  get: GetState
}

export type ExtractBookExtras = Action<[string]>

/**
 * Lazily extract a book's metadata extras (summary, narrator, series, ...)
 * from its local file. No-op unless the file exists and the stored extras
 * predate the current extractor (metadata_version) — call freely whenever
 * extras are about to be displayed. Idempotent; failures leave the version
 * unstamped so the next call retries.
 */
export const createExtractBookExtras: ActionFactory<ExtractBookExtrasDeps, ExtractBookExtras> = (deps) => (
  async (id) => {
    const { db, ffmetadata, syncQueue, set, get } = deps
    const log = createLogger('ExtractBookExtras')

    const book = get().books[id]
    if (!book?.uri) return // archived/deleted: no file to read
    if ((book.metadata_version ?? 0) >= EXTRACTED_METADATA_VERSION) return

    log(`Extracting extras for "${book.name}"`)
    const { tags } = await ffmetadata.read(book.uri)
    if (!tags) return // ffmpeg failed — retry on a later call

    // Fill only null fields — edited values (including cleared '') survive
    const extras = fillMissingExtras(book, extrasFromTags(tags))
    await db.setBookExtras(id, extras, EXTRACTED_METADATA_VERSION)
    await syncQueue.queueChange('book', id, 'upsert')

    set((state) => {
      const book = state.books[id]
      if (!book) return
      Object.assign(book, extras)
      book.metadata_version = EXTRACTED_METADATA_VERSION
      book.updated_at = Date.now()
    })
  }
)
