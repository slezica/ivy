/**
 * Chapter Reader Service
 *
 * Reads chapter metadata from audio files using ffprobe via native module.
 * Returns an empty array on failure — never throws.
 */

import { NativeModules } from 'react-native'
import { createLogger } from '../../utils'
import type { Chapter } from '../storage'

const log = createLogger('ChapterReader')

// =============================================================================
// Service
// =============================================================================

export class ChapterReaderService {
  async readChapters(fileUri: string): Promise<Chapter[]> {
    try {
      const filePath = fileUri.replace('file://', '')
      log(`Reading chapters from: ${filePath}`)

      const raw: RawChapter[] = await ChapterReader.readChapters(filePath)
      log(`Native module returned ${raw?.length ?? 'null'} items`)

      if (!raw.length) return []

      const chapters = raw.map(ch => ({
        title: ch.title || null,
        start_ms: Math.round(ch.start_ms),
        end_ms: Math.round(ch.end_ms),
      }))

      log(`Parsed ${chapters.length} chapters:`, chapters.map(c => c.title).join(', '))
      return chapters

    } catch (error) {
      log('Failed to read chapters:', error)
      return []
    }
  }
}


// =============================================================================
// Native Module
// =============================================================================

interface RawChapter {
  title: string | null
  start_ms: number
  end_ms: number
}

interface ChapterReaderInterface {
  readChapters(filePath: string): Promise<RawChapter[]>
}

const { ChapterReader } = NativeModules as {
  ChapterReader: ChapterReaderInterface
}
