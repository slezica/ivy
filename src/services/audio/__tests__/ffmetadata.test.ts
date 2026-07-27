import { parseFFmetadata, extrasFromTags, fillMissingExtras } from '../ffmetadata'

/**
 * Tests for the ffmetadata parser (INI-style text from `ffmpeg -f ffmetadata`).
 * The parsing used to live in Kotlin (ChapterReaderModule) where it was only
 * covered by e2e — these tests pin the ported behavior.
 */

const LIBATION_SAMPLE = `;FFMETADATA1
major_brand=isom
title=The Emperor's Soul
artist=Brandon Sanderson
album=The Emperor's Soul (Unabridged)
comment=When Shai is caught replacing the Moon Scepter with her nearly \\
flawless forgery, she must bargain for her life.
date=2012
composer=Angela Lin
LANGUAGE=English
AUDIBLE_ASIN=B009XEKR3O
SERIES=Elantris
PART=2
[CHAPTER]
TIMEBASE=1/1000
START=0
END=1500000
title=Chapter 1
[CHAPTER]
TIMEBASE=1/1000
START=1500000
END=3000000
title=Chapter 2
`

describe('parseFFmetadata', () => {

  describe('global tags', () => {
    it('parses tags with lowercased keys', () => {
      const { tags } = parseFFmetadata(LIBATION_SAMPLE)

      expect(tags).toMatchObject({
        title: "The Emperor's Soul",
        artist: 'Brandon Sanderson',
        date: '2012',
        composer: 'Angela Lin',
        language: 'English',
        audible_asin: 'B009XEKR3O',
        series: 'Elantris',
        part: '2',
      })
    })

    it('joins continuation lines (trailing backslash escapes the newline)', () => {
      const { tags } = parseFFmetadata(LIBATION_SAMPLE)

      expect(tags!.comment).toBe(
        'When Shai is caught replacing the Moon Scepter with her nearly \nflawless forgery, she must bargain for her life.'
      )
    })

    it('unescapes backslash sequences', () => {
      const { tags } = parseFFmetadata(';FFMETADATA1\ntitle=A \\= B \\; C \\# D \\\\ E\n')

      expect(tags!.title).toBe('A = B ; C # D \\ E')
    })

    it('ignores comment lines and the header', () => {
      const { tags } = parseFFmetadata(';FFMETADATA1\n#a comment\ntitle=Real\n')

      expect(tags).toEqual({ title: 'Real' })
    })

    it('stops attributing tags to the global section after a section header', () => {
      const { tags } = parseFFmetadata(';FFMETADATA1\ntitle=Global\n[STREAM]\ntitle=Stream Title\n')

      expect(tags).toEqual({ title: 'Global' })
    })

    it('returns empty tags for a file with no metadata', () => {
      const { tags, chapters } = parseFFmetadata(';FFMETADATA1\n')

      expect(tags).toEqual({})
      expect(chapters).toEqual([])
    })
  })

  describe('chapters', () => {
    it('parses chapter sections into milliseconds', () => {
      const { chapters } = parseFFmetadata(LIBATION_SAMPLE)

      expect(chapters).toEqual([
        { title: 'Chapter 1', start_ms: 0, end_ms: 1500000 },
        { title: 'Chapter 2', start_ms: 1500000, end_ms: 3000000 },
      ])
    })

    it('applies non-millisecond timebases', () => {
      const { chapters } = parseFFmetadata('[CHAPTER]\nTIMEBASE=1/44100\nSTART=44100\nEND=88200\ntitle=One\n')

      expect(chapters).toEqual([{ title: 'One', start_ms: 1000, end_ms: 2000 }])
    })

    it('defaults a missing timebase to 1/1000', () => {
      const { chapters } = parseFFmetadata('[CHAPTER]\nSTART=500\nEND=1000\n')

      expect(chapters).toEqual([{ title: null, start_ms: 500, end_ms: 1000 }])
    })

    it('skips chapters with missing or malformed START/END', () => {
      const { chapters } = parseFFmetadata(
        '[CHAPTER]\nSTART=oops\nEND=1000\n[CHAPTER]\nSTART=0\nEND=1000\ntitle=Good\n'
      )

      expect(chapters).toEqual([{ title: 'Good', start_ms: 0, end_ms: 1000 }])
    })

    it('keeps a trailing chapter that ends at EOF', () => {
      const { chapters } = parseFFmetadata('title=Book\n[CHAPTER]\nSTART=0\nEND=10')

      expect(chapters).toHaveLength(1)
    })
  })
})

describe('extrasFromTags', () => {
  it('maps audiobook tag conventions onto extras fields', () => {
    const { tags } = parseFFmetadata(LIBATION_SAMPLE)

    expect(extrasFromTags(tags!)).toMatchObject({
      narrator: 'Angela Lin',
      series: 'Elantris',
      part: '2',
      date: '2012',
      language: 'English',
      subtitle: null,
    })
  })

  it('nulls missing and empty tags', () => {
    expect(extrasFromTags({ comment: '', title: 'Kept Elsewhere' })).toEqual({
      summary: null,
      narrator: null,
      series: null,
      part: null,
      subtitle: null,
      date: null,
      language: null,
    })
  })
})

describe('fillMissingExtras', () => {
  const empty = {
    summary: null, narrator: null, series: null, part: null,
    subtitle: null, date: null, language: null,
  }

  it('fills null fields from the extracted values', () => {
    const extracted = { ...empty, summary: 'A story.', narrator: 'A Voice' }

    expect(fillMissingExtras(empty, extracted)).toEqual(extracted)
  })

  it('never overwrites non-null fields (edits win)', () => {
    const current = { ...empty, summary: 'Edited summary', narrator: null }
    const extracted = { ...empty, summary: 'File summary', narrator: 'A Voice' }

    expect(fillMissingExtras(current, extracted)).toEqual({
      ...empty, summary: 'Edited summary', narrator: 'A Voice',
    })
  })

  it('preserves cleared fields (empty string means edited-and-cleared)', () => {
    const current = { ...empty, summary: '' }
    const extracted = { ...empty, summary: 'File summary' }

    expect(fillMissingExtras(current, extracted).summary).toBe('')
  })
})
