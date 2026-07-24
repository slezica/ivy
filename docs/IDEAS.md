# Ideas & Improvements

Merged from feature brainstorm (2026-03-28) and two code-quality audits (April 2026).
Re-verified against the codebase 2026-07-18 (resolved/obsolete/low-value items removed)
and again 2026-07-23.

## Features

2. **Playlists / queues** — "play next" queue for podcast-style use, or named playlists.
3. **Clip collections / tags** — organize flat clip list for heavy clippers.
4. **Book artwork on player screen** — artwork is stored at import but never rendered on the player.
5. **Statistics dashboard** — `SessionHistogram` now shows listening time by day/week/month/year; still missing streaks and aggregate totals.
6. **Bulk import** — picker is single-file (`assets[0]`); no `multiple: true`, no multi-file action.
7. **Zoom buttons in ClipEditor** — discoverable alternative to the removed pinch zoom (2026-07-23: pinch was hard to execute without moving the timeline). The `canZoom` prop and engine pinch machinery are kept, currently unused by all callers.
8. **ClipViewer auto-pause precision** — pause at clip end triggers from 1 Hz position updates, so playback overshoots the boundary by up to ~1 s; with smooth playback follow (2026-07-23) the bars now visibly glide past the selection end before pausing.
9. **Auto-open clip editor from player with uninterrupted playback** — hitting the clip button opens the editor directly, audio keeps playing; combined with linked bounds (playhead pushes anchors), clipping becomes listen-and-pause in one motion.
10. **More readable settings** - always have subtitles below settings explaining use or state.
11. **Sync indicators in screens** - show in library, clips and sessions that missing items are being synced (only if missing, not at all times during any sync)

## Refactors / Architecture

10. **Split database service** — `database.ts` is a single ~1200-line file: inline migrations array plus one monolithic class holding CRUD, sync persistence, settings, lifecycle.
   *Test safety net: strong — `database.test.ts` + `migrations.test.ts` run against real SQLite.*
11. **Break sync engine into phases** — `sync.ts` is a single ~1700-line `BackupSyncService`; pull, reconcile, push, checkpoint are all private methods on one class.
    *Test safety net: strong — FakeDrive scenario harness covers pull/push/LWW/reconcile end-to-end.*
12. **Move `currentSessionBookId` out of the store** — the `// TODO sucks` wart (`store/index.ts:160`, `store/types.ts:72`); encapsulate in the session-tracking actions or a dedicated tracker.
    *Test safety net: good — `store/__tests__/session.test.ts` plus `track_session`/`finalize_session` action tests.*
13. **Extract playback ownership abstraction** — remembered position / ownership claim / loaded-file logic duplicated (~50 LOC each) in PlayerScreen, ClipViewer, ClipEditor; no shared hook exists.
    *Test safety net: none — zero component tests; only Maestro happy-path smoke (load-and-play, clip-crud).*
14. **Decompose large screens** — extract a shared search-toggle hook (duplicated in LibraryScreen/ClipsListScreen) and fix the `any`-typed `ClipList` props (`ClipsListScreen.tsx:244`).
    *Test safety net: none — no screen tests; Maestro covers import/search-free happy paths only.*
15. **Move foreground auto-sync out of LibraryScreen** — sync-on-foreground lives in a screen effect (`AppState.addEventListener`), so it depends on which screen is mounted.
    *Test safety net: none — the effect is untested; only sync internals have coverage.*
16. **Unified error handling strategy** — no convention: raw throws (`add_clip.ts`), no try/catch (`delete_clip.ts`), a file-local `handleError` (`load_file.ts`), silent `.catch(() => {})` swallows. The toast helper (`services/system/toast.ts`, added 2026-07-22) is a candidate convention for user-facing surfacing.
    *Test safety net: partial — 17 action test files catch changed throw/return behavior, but swallowed-error paths are inherently untested.*
17. **Typed menu actions** — `handleMenuAction(action: string)` with string-literal switches in both screens; `ActionMenu` is not generic (`key: string`).
    *Test safety net: n/a — the compiler is the net; Maestro clip-crud/archive flows exercise the menus.*
18. **Extract player sub-components** — SpeedControl and ChapterList still inlined in 424-line PlayerScreen.
    *Test safety net: none at unit level, but it's a pure file move — TypeScript plus Maestro load-and-play suffice.*

## Testing

19. **Screen tests** — store, sync, database, and action coordination tests now exist; screens still have zero tests.
20. **Cover remaining untested services** — gaps narrowed to `audio/player.ts`, system services (sharing), and `start/stop_transcription` actions.
21. **Snapshot / visual regression testing** — 7 Maestro flows exist (plus subflows and screenshot flows), but no Storybook or screenshot comparison; styling regressions still uncaught.

## Known-good areas (from audit)

Action factories and tests, theme tokens, timeline structure, shared components, store types, BaseService event system.

## Resolved since the audits

- Sleep timer (was feature #1) — implemented 2026-07-24; wall-clock countdown with fade-out ("end of chapter" mode dropped, see docs/2026-07-24-sleep-timer.md).
- Ingestion pipeline duplication — `load_from_url.ts` deleted with yt-dlp removal; `sanitizeFilename` centralized in `src/utils/`.
- `uriToPath()` duplication — centralized in `src/utils/index.ts`, imported by all three consumers.
- Transcription queue race — `processing` flag now reset in `finally` blocks (`queue.ts`).
- Strong danger language — clip deletion (the only hard loss) now says "Delete forever" / "Permanently delete this clip?"; book remove/archive are recoverable, left as-is (2026-07-24).

## Dropped by review (2026-07-18)

- Slim the store's container role — 294 lines of visible wiring is proportionate; logic already lives in action factories.
- Standardize service patterns — symmetry churn with little behavioral payoff.
- Runtime theme switching — high cost (module-scope `StyleSheet.create` everywhere), zero benefit until a theme feature is planned.
