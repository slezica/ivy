import { libraryPress } from '../library_press'
import { MAIN_PLAYER_OWNER_ID } from '../../utils'

const book = { id: 'b1', uri: 'file:///audio/b1.m4a', position: 10_000 } as any

describe('libraryPress', () => {
  it('keeps the loaded book going from the live position, without a load', () => {
    const press = libraryPress(book, { uri: book.uri, ownerId: MAIN_PLAYER_OWNER_ID, position: 13_400 })
    expect(press.needsLoad).toBe(false)
    expect(press.context).toEqual({ fileUri: book.uri, position: 13_400, ownerId: MAIN_PLAYER_OWNER_ID })
  })

  it('loads another book at its saved position', () => {
    const press = libraryPress(book, { uri: 'file:///audio/other.m4a', ownerId: MAIN_PLAYER_OWNER_ID, position: 5_000 })
    expect(press.needsLoad).toBe(true)
    expect(press.context.position).toBe(10_000)
  })

  it('loads when the same file is held by another owner (clip editor)', () => {
    const press = libraryPress(book, { uri: book.uri, ownerId: 'clip-editor', position: 5_000 })
    expect(press.needsLoad).toBe(true)
    expect(press.context.position).toBe(10_000)
  })
})
