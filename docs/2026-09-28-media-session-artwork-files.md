# Media-session artwork as cache files

Follow-up to [2026-09-28-systemui-artwork-crash.md](2026-09-28-systemui-artwork-crash.md),
which dropped artwork from the media session (v1.6.6) to stop One UI's
SystemUI from crashing. This restores the cover without the crash.

## Idea

Keep books' artwork as data URIs in the DB, but hand the media session a
`file://` URI instead:

- `artworkFileUri()` (`src/services/audio/artwork.ts`) writes the image to
  `cache/artwork/<fnv1a>-<length>.<ext>` and returns its `file://` URI.
- `AudioPlayerService.load()` passes that to TrackPlayer. On any fs error, it
  loads with no cover; playback never fails because of artwork.

Session metadata drops from ~0.5MB to a few hundred bytes regardless of cover
size.

## Why it works

- media3 decodes `artworkUri` **in Ivy's process** (`BitmapLoader`) and puts
  the bitmap into the session (`DISPLAY_ICON` + `ALBUM_ART`). The bitmap
  travels out of band (shared memory), not inline in binder replies.
- The URI strings still go into 3 keys, but a file path is tiny.
- SystemUI tries the URI first and can't read Ivy's private cache
  (`MediaDataManager: Unable to load bitmap ... ENOENT`, caught). Then it falls
  back to the bitmap. Harmless noise.

## Measurements

"Large reply" = system_server's `Large reply transaction of N bytes,
ISessionController` log (logged above ~300KB).

| Device | Build | Cover | Large replies | Binder failures | Art shown |
|---|---|---|---|---|---|
| Galaxy S25, Android 16 | 1.6.5 | Tress (~87K chars) | 178 × 523,264 B | `-28 ENOSPC`, SystemUI crash | — |
| Emulator, Android 16 | data URI | 87K chars | 28 × 521,636 B | 3 × `-28 ENOSPC` (caught) | — |
| Emulator, Android 16 | file URI | 87K chars | 0 | 0 | yes |
| Pixel 5, Android 14 | 1.6.5 | ~56K chars | 73 × 337,388 B | 0 | — |
| Pixel 5, Android 14 | file URI | ~56K chars | 0 | 0 | yes |

The file write takes 1–5ms, negligible next to `load()`'s duration poll.

## Details

- **Cache naming:** content hash + length. The same cover is written once, and
  changed artwork gets a new name. Other files in the dir are pruned on each
  call, so it holds one cover. The OS may clear the cache; the next load
  rewrites the file.
- **Atomicity:** write `.tmp` then rename. media3 loads asynchronously and
  never sees a partial file.
- **Non-data URIs** pass through; malformed data URIs yield no cover.

## Regression guard

- Jest: `player.test.ts` asserts `load()` hands TrackPlayer the `file://` URI.
  `artwork.test.ts` covers writing, reuse, pruning and failures.
- Toolkit: e2e runs (`test --e2e`, `prepare`) fail on any large
  `ISessionController` reply in `log/e2e-logcat.txt` (`largeSessionReplies`
  in `bin/ivy.ts`). This catches any path that bloats session metadata, not
  only artwork. Limit: fixture covers are small (~45K chars → ~270KB, under
  the log threshold), so the jest test is the primary guard for artwork
  specifically.

## Rejected alternatives

- **No artwork (v1.6.6):** safe, but loses lock-screen and notification art.
- **Smaller session-only cover:** shrinks the payload, but the crash stays
  size-dependent.
- **FileProvider `content://` URI:** would let SystemUI read the file itself
  and silence the ENOENT noise. It needs a manifest provider and URI grants to
  SystemUI, for no user-visible gain. Revisit if some SystemUI shows no art
  without it.

## Open

- Not yet verified on One UI (no Samsung in hand). Checked on the v1.6.7 alpha:
  play/pause Tress repeatedly; the logs must show no large replies.
