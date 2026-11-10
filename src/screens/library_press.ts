import type { Book } from '../services/storage/database'
import type { LoadBookContext } from '../actions/load_book'
import { MAIN_PLAYER_OWNER_ID } from '../utils'

export interface LibraryPress {
  context: LoadBookContext
  needsLoad: boolean   // false: the book is already in the main player
}

/**
 * What tapping a library row does. A book already loaded in the main player
 * keeps going from the LIVE position: the row's saved position lags
 * (persisted every few seconds), and passing it would seek back — an audible
 * stutter. Any other book loads at its saved position.
 */
export function libraryPress(
  book: Book & { uri: string },
  playback: { uri: string | null, ownerId: string | null, position: number },
): LibraryPress {
  const loaded = playback.uri === book.uri && playback.ownerId === MAIN_PLAYER_OWNER_ID
  return {
    context: {
      fileUri: book.uri,
      position: loaded ? playback.position : book.position,
      ownerId: MAIN_PLAYER_OWNER_ID,
    },
    needsLoad: !loaded,
  }
}
