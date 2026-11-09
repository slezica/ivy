/**
 * Artwork Store
 *
 * Book covers as files in app storage (<documents>/artwork/), named
 * `<bookId>.<hash4>.<ext>`. The DB holds only the filename — full paths are
 * built here at runtime, since app storage paths can differ across installs.
 * Design: docs/2026-09-28-artwork-as-files.md.
 *
 * - hash4: first 4 hex chars of fnv1a over the base64 content. A changed
 *   cover gets a new filename, busting <Image>'s URI cache.
 * - ext: from the data URI's image type (jpeg → jpg).
 *
 * Replacing a cover: write the new file → update the row → remove the old
 * file. A crash in between leaves an orphan (swept) or a row pointing at a
 * missing file (reads as "no cover").
 */

import RNFS from 'react-native-fs'

import { createLogger, fnv1a } from '../../utils'

const log = createLogger('ArtworkStore')

export const ARTWORK_DIR = `${RNFS.DocumentDirectoryPath}/artwork`

const DATA_URI = /^data:image\/(\w+);base64,/
// Base64 alphabet, tolerating line breaks (Android's Base64.DEFAULT wraps)
const BASE64 = /^[A-Za-z0-9+/=\r\n]+$/

const TEMP_SUFFIX = '.tmp'

export interface ParsedArtwork {
  base64: string   // raw payload, header stripped
  ext: string      // file extension for the image type ('jpg', 'png', ...)
}

/**
 * Split an image data URI into payload and extension. Returns null when it
 * isn't a non-empty base64 image data URI (nothing a file could hold).
 */
export function parseArtwork(dataUri: string): ParsedArtwork | null {
  const match = dataUri.match(DATA_URI)
  if (!match) return null

  const base64 = dataUri.slice(match[0].length)
  if (!BASE64.test(base64)) return null

  const type = match[1].toLowerCase()
  return { base64, ext: type === 'jpeg' ? 'jpg' : type }
}

/** Deterministic cover filename: `<bookId>.<hash4>.<ext>`. */
export function artworkFilename(bookId: string, artwork: ParsedArtwork): string {
  const hash4 = fnv1a(artwork.base64).toString(16).padStart(8, '0').slice(0, 4)
  return `${bookId}.${hash4}.${artwork.ext}`
}

/**
 * file:// URI of a stored cover (a book's artwork_file), for <Image> and the
 * media session. Null for no cover. A missing file is not checked here:
 * readers render it as no image.
 */
export function artworkUri(filename: string | null | undefined): string | null {
  return filename ? `file://${ARTWORK_DIR}/${filename}` : null
}

const MIME_BY_EXT: Record<string, string> = { jpg: 'jpeg' }

export class ArtworkStore {
  constructor(readonly dir: string = ARTWORK_DIR) {}

  /** Absolute path of a cover file (no file:// prefix). */
  path(filename: string): string {
    return `${this.dir}/${filename}`
  }

  /** file:// URI of a cover file, for <Image> and the media session. */
  uri(filename: string): string {
    return `file://${this.path(filename)}`
  }

  /**
   * Write a cover from its data URI, returning the filename to store on the
   * row. Same book + same image = same filename, so an existing file is reused
   * (reruns and retries write nothing). Returns null for input that isn't a
   * base64 image data URI. Throws on filesystem errors.
   */
  async write(bookId: string, dataUri: string): Promise<string | null> {
    const artwork = parseArtwork(dataUri)
    if (!artwork) return null

    const filename = artworkFilename(bookId, artwork)
    const path = this.path(filename)
    if (await RNFS.exists(path)) return filename

    await RNFS.mkdir(this.dir)
    // Write-then-rename: readers never see a half-written file
    await RNFS.writeFile(`${path}${TEMP_SUFFIX}`, artwork.base64, 'base64')
    await RNFS.moveFile(`${path}${TEMP_SUFFIX}`, path)
    return filename
  }

  /**
   * Read a cover back as a data URI (the sync wire format). Null when the
   * file is missing — local truth is then "no cover".
   */
  async readDataUri(filename: string): Promise<string | null> {
    const path = this.path(filename)
    if (!(await RNFS.exists(path))) return null

    const ext = filename.slice(filename.lastIndexOf('.') + 1)
    const base64 = await RNFS.readFile(path, 'base64')
    return `data:image/${MIME_BY_EXT[ext] ?? ext};base64,${base64}`
  }

  /** Delete a cover file. Best-effort: a leftover is an orphan for sweep(). */
  async remove(filename: string): Promise<void> {
    const path = this.path(filename)
    try {
      if (await RNFS.exists(path)) await RNFS.unlink(path)
    } catch (error) {
      log(`Failed to remove ${filename}:`, error)
    }
  }

  /**
   * Delete every file not in `referenced` (orphans and stale temp files).
   * Returns the number removed. Must not run concurrently with writes: a
   * file written but not yet on its row would count as an orphan.
   */
  async sweep(referenced: Iterable<string>): Promise<number> {
    if (!(await RNFS.exists(this.dir))) return 0

    const keep = new Set(referenced)
    let removed = 0
    for (const entry of await RNFS.readDir(this.dir)) {
      if (keep.has(entry.name)) continue
      try {
        await RNFS.unlink(entry.path)
        removed++
      } catch (error) {
        log(`Failed to sweep ${entry.name}:`, error)
      }
    }
    return removed
  }

  /** Delete the whole artwork directory (clearAllData's file-side twin). */
  async clear(): Promise<void> {
    if (await RNFS.exists(this.dir)) await RNFS.unlink(this.dir)
  }
}
