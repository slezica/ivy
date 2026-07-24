/**
 * FFmetadata Service
 *
 * Reads a file's full metadata (global tags + chapters) via the bundled
 * ffmpeg binary (FFmetadataReaderModule returns the raw ffmetadata text;
 * parsing happens here, where it's unit-testable).
 *
 * Global tags are the only way to reach `comment`, narrator (`composer`) and
 * custom MP4 tags (SERIES, PART, ...) — Android's MediaMetadataRetriever
 * cannot read them. Basics (title/artist/artwork/duration) intentionally stay
 * on the retriever (AudioMetadataService): it's an in-process platform API
 * that survives any ffmpeg breakage.
 */

import { NativeModules } from 'react-native'
import { createLogger } from '../../utils'
import type { BookExtras, Chapter } from '../storage'

const log = createLogger('FFmetadata')

/**
 * Version of the tag → extras mapping (extrasFromTags). Bump when the
 * extractor learns new fields: books stamped with an older version lazily
 * re-extract on their next details view (see extract_book_extras).
 */
export const EXTRACTED_METADATA_VERSION = 1

/** Global tags, keys lowercased (the MP4 demuxer emits custom keys uppercase). */
export type FileTags = Record<string, string>

export interface FileMetadata {
  tags: FileTags | null // null = ffmpeg failed (distinct from "no tags": {})
  chapters: Chapter[]
}

// =============================================================================
// Service
// =============================================================================

export class FFmetadataService {
  /** Never throws: ffmpeg failure yields { tags: null, chapters: [] }. */
  async read(fileUri: string): Promise<FileMetadata> {
    try {
      const filePath = fileUri.replace('file://', '')
      log(`Reading ffmetadata from: ${filePath}`)

      const text = await FFmetadataReader.read(filePath)
      if (text === null) {
        log('Native reader failed (null)')
        return { tags: null, chapters: [] }
      }

      const metadata = parseFFmetadata(text)
      log(`Parsed ${Object.keys(metadata.tags ?? {}).length} tags, ${metadata.chapters.length} chapters`)
      return metadata

    } catch (error) {
      log('Failed to read ffmetadata:', error)
      return { tags: null, chapters: [] }
    }
  }
}

// =============================================================================
// Extras mapping
// =============================================================================

/**
 * Map ffmetadata global tags onto Book extras. Sources follow audiobook
 * tagging conventions (Libation et al): `comment` carries the publisher
 * summary, `composer` the narrator. Empty values become null.
 */
export function extrasFromTags(tags: FileTags): BookExtras {
  return {
    summary: tags['comment'] || null,
    narrator: tags['composer'] || null,
    series: tags['series'] || null,
    part: tags['part'] || null,
    subtitle: tags['subtitle'] || null,
    date: tags['date'] || null,
    language: tags['language'] || null,
  }
}

// =============================================================================
// Parsing
// =============================================================================

/**
 * Parse ffmetadata text (INI-style):
 *
 * ;FFMETADATA1
 * title=The Emperor's Soul
 * comment=Long text\
 * continued on the next line
 * [CHAPTER]
 * TIMEBASE=1/1000
 * START=0
 * END=1234567
 * title=Chapter One
 *
 * Values escape special characters (\= \; \# \\); a trailing lone backslash
 * escapes the newline, continuing the value on the next line.
 */
export function parseFFmetadata(text: string): FileMetadata {
  const lines = text.split('\n')
  const tags: FileTags = {}
  const chapters: Chapter[] = []

  let section: FileTags | null = tags // null = unknown section ([STREAM], ...)
  let chapterFields: FileTags | null = null

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith(';') || line.startsWith('#')) { i++; continue } // comment
    if (line.startsWith('[')) {
      if (chapterFields) chapters.push(...buildChapter(chapterFields))
      if (line.trim() === '[CHAPTER]') {
        chapterFields = {}
        section = chapterFields
      } else {
        chapterFields = null
        section = null
      }
      i++
      continue
    }

    const eq = line.indexOf('=')
    if (eq > 0 && section) {
      const key = unescapeValue(line.substring(0, eq).trim())
      let value = line.substring(eq + 1)
      // A trailing unescaped backslash escapes the newline: the value
      // continues on the next line
      while (endsInLoneBackslash(value) && i + 1 < lines.length) {
        i++
        value = value.slice(0, -1) + '\n' + lines[i]
      }
      // Chapter keys stay verbatim (TIMEBASE vs title); global tags are
      // lowercased so MP4 custom keys (SERIES) and plain ones (title) unify
      section[section === tags ? key.toLowerCase() : key] = unescapeValue(value.trim())
    }
    i++
  }
  if (chapterFields) chapters.push(...buildChapter(chapterFields))

  return { tags, chapters }
}

/** A chapter section, or nothing when START/END are missing or malformed. */
function buildChapter(fields: FileTags): Chapter[] {
  const timebase = parseTimebase(fields['TIMEBASE'])
  const start = parseInteger(fields['START'])
  const end = parseInteger(fields['END'])
  if (start === null || end === null) return []

  return [{
    title: fields['title'] || null,
    start_ms: Math.round(start * timebase * 1000),
    end_ms: Math.round(end * timebase * 1000),
  }]
}

/** True if the string ends in an odd number of backslashes (a lone, unescaped one). */
function endsInLoneBackslash(value: string): boolean {
  let count = 0
  for (let i = value.length - 1; i >= 0 && value[i] === '\\'; i--) count++
  return count % 2 === 1
}

/**
 * Unescape ffmetadata backslash sequences (\\, \=, \;, \# — a backslash
 * escapes whatever character follows it). A trailing lone backslash is dropped.
 */
function unescapeValue(raw: string): string {
  let result = ''
  let i = 0
  while (i < raw.length) {
    if (raw[i] === '\\' && i + 1 < raw.length) {
      result += raw[i + 1]
      i += 2
    } else if (raw[i] === '\\') {
      i++ // trailing lone backslash — drop it
    } else {
      result += raw[i]
      i++
    }
  }
  return result
}

/** Parse TIMEBASE=num/den into a multiplier (seconds per unit). Defaults to 1/1000. */
function parseTimebase(value: string | undefined): number {
  if (!value) return 0.001
  const parts = value.split('/')
  if (parts.length !== 2) return 0.001
  const num = parseInteger(parts[0])
  const den = parseInteger(parts[1])
  if (num === null || den === null || den === 0) return 0.001
  return num / den
}

/** Strict integer parse: null on anything but digits (parseInt is too lax). */
function parseInteger(value: string | undefined): number | null {
  if (value === undefined || !/^-?\d+$/.test(value.trim())) return null
  return parseInt(value, 10)
}

// =============================================================================
// Native Module
// =============================================================================

interface FFmetadataReaderInterface {
  read(filePath: string): Promise<string | null>
}

const { FFmetadataReader } = NativeModules as {
  FFmetadataReader: FFmetadataReaderInterface
}
