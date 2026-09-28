# SystemUI crash on pause (artwork in media session)

## Symptom

Galaxy S25 (One UI, Android 16). Play/pause on one book ("Tress of the Emerald
Sea") often crashed SystemUI: screen flashed, restarted at the lock screen, play
button stuck mid-transition. Never with other books.

## Diagnosis

From `logcat -b all` + `dumpsys dropbox system_app_crash` on the device:

- Every Ivy `ISessionController.getMetadata()` reply was **523,264 bytes**
  (`libbinder.Binder: Large reply transaction`).
- On a state change, ~5 SystemUI components (QS media player, AOD/face widget,
  seek bar, ongoing-activity chip) fetch metadata concurrently.
- 5 × 0.5MB overflows SystemUI's ~1MB binder buffer →
  `BR_FAILED_REPLY ... -28 (No space left on device)` →
  `DeadSystemException` at `MediaController.getMetadata` → SystemUI dies.

Why 0.5MB:

- `book.artwork` is a base64 data URI (512px JPEG q80, ~87K chars for Tress).
- RNTP passes it as media3 `artworkUri`.
- media3 `LegacyConversions` writes `artworkUri` into 3 keys:
  `DISPLAY_ICON_URI`, `ALBUM_ART_URI`, `ART_URI`.
- Parcel strings are UTF-16: 87K × 2 × 3 ≈ 523KB.

Size varies by cover detail (backup JSONs 37–91KB); Tress was the largest,
hence book-specific and racy.

## Decision (immediate)

Don't pass artwork to TrackPlayer. System media controls show no cover art.

## Follow-up options

- Write artwork to a file, pass `file://` (or FileProvider `content://`) URI —
  metadata drops to ~300 bytes regardless of cover size. Open: whether
  SystemUI can read Ivy's private files (may need FileProvider).
- Smaller session-only artwork: shrinks payload, still size-dependent.
