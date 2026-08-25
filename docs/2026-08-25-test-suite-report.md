# 2026-08-25 — Test Suite Report

Full run of both suites on branch `test-suite-work`. Environment: container + Mac-hosted emulator.

## Results

- Unit: 547/547 pass (41 suites, ~24s).
- E2e: 11/11 pass (10m24s) after two suite fixes (below). Maestro variant rebuilt + installed first.
- Run history: run 1 = 10/11 (stale assertion); run 2 = 9/11 (flakes under whisper-download load); run 3 after fixes = 11/11.

## Suite fixes (committed)

- `transcription-states` failed at the give-up assertion. Cause: commit `3c19da9` reworded the banner and added a trailing period ("Tap to retry.") but the flow regex kept the old ending. Maestro full-matches regexes. Fixed in `9ae17d6`.
- Flakiness under load: every `clearState` flow launches into fresh state → transcription enabled by default → the app starts the 465MB whisper-model download immediately (~3.3MB/s, ≈2.5 min of network/CPU/JS-event saturation per flow). Observed effects: `sleep-timer` ran 6m43s (vs 42s) and missed its 15s expiry window; `transcription-states` missed a 20s download-start window. Fixed in `f5cc1dc`: `import-book` subflow (and `delete-original`) launch offline via the bridge, toggle transcription off in Settings, then restore connectivity. The offline launch matters because the toggle can't stop a download already in flight (see app bugs).

## Environment issues (fixed, not committed — container/emulator state)

- Maestro CLI missing in container (known: doesn't survive recreation). Reinstalled 2.8.0, PATH persisted in `.bashrc`.
- Emulator `/data` at 95% — maestro APK install failed ("not enough space"). Ivy app data was ~540MB (imported audio + whisper model). `device wipe` freed it.

## App bugs found (not fixed)

- Toggling transcription off does not cancel an in-flight model download. `TranscriptionQueueService.stop()` (queue.ts:88) clears flags/queue, but `whisper.ts` `ensureModelDownloaded` never calls `RNFS.stopDownload` — the 465MB download runs to completion. User impact: bandwidth/battery wasted after opting out; a re-toggle during that window would also hit the "Download already in progress" error path.

## Speed notes (not applied)

- `base64.test.ts` is 21s of the 24s unit wall time. Culprit: `expect(bytes).toEqual(decoded)` on a 3MB `Uint8Array` — jest deep-equal walks 3M elements. Fix: compare via `Buffer.from(a).equals(Buffer.from(b))` (or compare a hash). Should drop the suite to ~5s.
- E2e is serial, ~9 min. Biggest per-flow costs are app relaunch + `clearState`. No cheap wins visible; maestro startup overhead is fixed cost per flow.

## Coverage gaps (not filled)

Unit:
- `services/audio/integration.ts` — remote-control event wiring (play/pause/seek from notification). Has logic, no tests.
- `services/system/network.ts` — NetInfo wrapper with connectivity/metered event mapping. No tests.
- `actions/auto_sync.ts`, `sync_now.ts` — thin but orchestrate sync triggers; untested.
- Remaining untested files are thin native wrappers (picker, copier, sharing, toast, whisper) — low value to unit-test.

E2e:
- Archive → re-import restore path (position preservation) — archive is only used as setup in `add-clip`.
- Sessions screen (history list + histogram) — no flow.
- Settings beyond transcription (sync toggle, delete-original toggle is covered via `delete-original`).
- Playback speed control — no flow.
- Search (library and clips) — no flow.
- Sync engine has no e2e (by design: unit-level FakeDrive scenarios cover it).

## Tooling suggestions (not applied)

- `doctor` could warn on emulator disk pressure (df /data) — today the failure surfaces late, as an obscure `adb install` error after a full build.
- `build --install` could pre-check free space vs APK size and suggest `device wipe`.
- E2e failure output: toolkit could print the maestro debug dir (screenshot + hierarchy path) for the failing flow — it's in the log but easy to miss.
- Wording assertions in flows are brittle (full-match regex vs UI copy). Convention worth adopting: assert on stable substrings with `.*` anchors, or add testIDs to banners and assert by id.
- Maestro-build launch-arg affordance to preseed settings (e.g. transcription off) would replace the offline-launch + Settings-toggle dance in `import-book` with one `launchApp: arguments:` line, and shave a few seconds per flow.
