import { stripEnclosingQuotes } from '../index'

describe('stripEnclosingQuotes', () => {
  it('strips straight quotes wrapping the whole text', () => {
    expect(stripEnclosingQuotes('"Hello world."')).toBe('Hello world.')
  })

  it('strips curly quotes wrapping the whole text', () => {
    expect(stripEnclosingQuotes('“Hello world.”')).toBe('Hello world.')
  })

  it('trims whitespace left behind by the quotes', () => {
    expect(stripEnclosingQuotes('" Hello. "')).toBe('Hello.')
  })

  it('keeps dialogue quotes that are not enclosing', () => {
    const dialogue = '"Hello", he said. "How are you?"'
    expect(stripEnclosingQuotes(dialogue)).toBe(dialogue)
  })

  it('keeps edge quotes when more quotes appear inside', () => {
    const text = '“He said "hi" to me”'
    expect(stripEnclosingQuotes(text)).toBe(text)
  })

  it('keeps text with a quote on only one edge', () => {
    expect(stripEnclosingQuotes('"Hello world.')).toBe('"Hello world.')
    expect(stripEnclosingQuotes('Hello world."')).toBe('Hello world."')
  })

  it('keeps unquoted text and degenerate inputs', () => {
    expect(stripEnclosingQuotes('Hello world.')).toBe('Hello world.')
    expect(stripEnclosingQuotes('"')).toBe('"')
    expect(stripEnclosingQuotes('')).toBe('')
  })
})
