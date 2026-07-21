#!/usr/bin/env node
/**
 * Generate demo audio files for Play Store screenshots.
 *
 * Builds valid silent MP3s of arbitrary duration by repeating a single
 * pre-encoded silent frame (MPEG-2.5 Layer III, 8kHz mono, 8kbps, 72ms per
 * 72-byte frame) — no ffmpeg needed, ~1KB per second of audio.
 *
 * The hero book (books[0] in data.json) auto-loads into the player, whose
 * position display syncs with the real file, so its audio is generated at the
 * book's full stated duration. Other books never load, so they share a short
 * file; clips share one clip-length file.
 *
 * Output goes to playstore/cache/ (gitignored). Existing files with the
 * expected size are kept, so re-runs are instant.
 */

const fs = require('fs')
const path = require('path')

// One silent MPEG-2.5 Layer III frame: 8kHz mono, 8kbps, 576 samples = 72ms
const SILENT_FRAME = Buffer.from(
  '/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV',
  'base64'
)
const FRAME_MS = 72

const SHORT_MS = 60_000 // non-hero books: never loaded into the player
const CLIP_MS = 45_000  // shared clip audio: longest clip in data.json

function writeSilence(outPath, durationMs) {
  const frames = Math.ceil(durationMs / FRAME_MS)
  const expectedSize = frames * SILENT_FRAME.length

  if (fs.existsSync(outPath) && fs.statSync(outPath).size === expectedSize) {
    console.log(`kept  ${path.basename(outPath)} (${(expectedSize / 1e6).toFixed(1)}MB)`)
    return
  }

  const stream = fs.createWriteStream(outPath)
  // Write in 1000-frame chunks to keep memory flat for multi-hour files
  const chunk = Buffer.concat(Array(1000).fill(SILENT_FRAME))
  let written = 0
  while (written + 1000 <= frames) {
    stream.write(chunk)
    written += 1000
  }
  stream.write(Buffer.concat(Array(frames - written).fill(SILENT_FRAME)))
  stream.end()
  console.log(`wrote ${path.basename(outPath)} (${(expectedSize / 1e6).toFixed(1)}MB)`)
}

const root = __dirname
const data = JSON.parse(fs.readFileSync(path.join(root, 'data.json'), 'utf8'))
const cacheDir = path.join(root, 'cache')
fs.mkdirSync(cacheDir, { recursive: true })

const [hero, ...rest] = data.books
if (hero.audio) writeSilence(path.join(cacheDir, hero.audio), hero.duration)

const shortFiles = new Set(rest.map((book) => book.audio).filter(Boolean))
for (const file of shortFiles) writeSilence(path.join(cacheDir, file), SHORT_MS)

const clipFiles = new Set(data.clips.map((clip) => clip.audio))
for (const file of clipFiles) writeSilence(path.join(cacheDir, file), CLIP_MS)
