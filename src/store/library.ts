import type {
  DatabaseService,
  FileStorageService,
  FilePickerService,
  AudioMetadataService,
  AudioPlayerService,
  SyncQueueService,
  BackupSyncService,
  PlaybackStatus,
  SyncNotification,
} from '../services'
import type { LibrarySlice, SetState, GetState } from './types'
import { MAIN_PLAYER_OWNER_ID, throttle } from '../utils'
import { createFetchBooks } from '../actions/fetch_books'
import { createFetchClips } from '../actions/fetch_clips'
import { createLoadFile } from '../actions/load_file'
import { createLoadFileWithUri } from '../actions/load_file_with_uri'
import { createLoadFileWithPicker } from '../actions/load_file_with_picker'
import { createArchiveBook } from '../actions/archive_book'
import { createDeleteBook } from '../actions/delete_book'


export interface LibrarySliceDeps {
  db: DatabaseService
  files: FileStorageService
  picker: FilePickerService
  metadata: AudioMetadataService
  audio: AudioPlayerService
  syncQueue: SyncQueueService
  sync: BackupSyncService
}


export function createLibrarySlice(deps: LibrarySliceDeps) {
  const { db, files, picker, metadata, audio, syncQueue, sync } = deps

  const queuePositionSync = throttle((bookId: string) => {
    syncQueue.queueChange('book', bookId, 'upsert')
  }, 30_000)

  return (set: SetState, get: GetState): LibrarySlice => {
    const fetchBooks = createFetchBooks({ db, set })
    const fetchClips = createFetchClips({ db, set })
    const archiveBook = createArchiveBook({ db, files, syncQueue, set, get })
    const deleteBook = createDeleteBook({ db, files, syncQueue, set, get })
    const loadFile = createLoadFile({ db, files, metadata, syncQueue, set, fetchBooks, fetchClips })
    const loadFileWithUri = createLoadFileWithUri({ loadFile })
    const loadFileWithPicker = createLoadFileWithPicker({ picker, loadFile })

    audio.on('status', onPlaybackStatus)
    sync.on('data', onSyncData)

    return {
      library: {
        status: 'loading',
      },
      books: {},

      fetchBooks,
      loadFile,
      loadFileWithUri,
      loadFileWithPicker,
      archiveBook,
      deleteBook,
    }

    function onPlaybackStatus(status: PlaybackStatus) {
      const { playback, books } = get()
      if (!playback.uri || status.position < 0 || status.duration <= 0) return
      if (playback.ownerId !== MAIN_PLAYER_OWNER_ID) return

      const book = Object.values(books).find(b => b.uri === playback.uri)
      if (!book) return

      db.updateBookPosition(book.id, status.position)
      queuePositionSync(book.id)
    }

    function onSyncData(notification: SyncNotification) {
      if (notification.booksChanged.length > 0) {
        fetchBooks()
      }
    }
  }
}
