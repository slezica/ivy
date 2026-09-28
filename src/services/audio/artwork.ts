/**
 * Media-session artwork files.
 *
 * Books store artwork as base64 data URIs, but the media session must not
 * carry one: media3 copies `artworkUri` into 3 metadata keys as UTF-16
 * strings, so an ~87K-char cover became ~0.5MB metadata replies that overflow
 * SystemUI's binder buffer when several of its widgets fetch at once, crashing
 * it on One UI (docs/2026-09-28-systemui-artwork-crash.md). Writing the image
 * to a cache file and passing its file:// URI keeps metadata tiny; media3
 * decodes the file in-process and ships the bitmap out of band.
 */

import RNFS from 'react-native-fs'

export const ARTWORK_CACHE_DIR = `${RNFS.CachesDirectoryPath}/artwork`

const DATA_URI = /^data:image\/(\w+);base64,/

/**
 * Resolve a stored artwork value to a URI safe for the media session.
 *
 * Data URIs are written to ARTWORK_CACHE_DIR, named by content hash (the same
 * image is written once; changed artwork gets a new file). Other files in the
 * dir are pruned, so it holds only the current cover. Non-data URIs pass
 * through. Returns null for empty or unrecognized input. Throws on fs errors.
 */
export async function artworkFileUri(artwork: string | null | undefined): Promise<string | null> {
  if (!artwork) return null
  if (!artwork.startsWith('data:')) return artwork

  const match = artwork.match(DATA_URI)
  if (!match) return null

  const base64 = artwork.slice(match[0].length)
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
  const name = `${fnv1a(base64)}-${base64.length}.${ext}`
  const path = `${ARTWORK_CACHE_DIR}/${name}`

  if (!(await RNFS.exists(path))) {
    await RNFS.mkdir(ARTWORK_CACHE_DIR)
    // Write-then-rename: media3 loads the file asynchronously, never half-written
    await RNFS.writeFile(`${path}.tmp`, base64, 'base64')
    await RNFS.moveFile(`${path}.tmp`, path)
  }

  for (const entry of await RNFS.readDir(ARTWORK_CACHE_DIR)) {
    if (entry.name !== name) await RNFS.unlink(entry.path).catch(() => {})
  }

  return `file://${path}`
}

/** 32-bit FNV-1a, hex. Identity for cache names, not security. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
