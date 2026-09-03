# The Sessions System

A guide for Ivy's listening history tracking.

## The Big Picture

Ivy automatically tracks how long the user listens to each book. Every time the user plays an audiobook in the main player, a **session** is created — a record with a start time and an end time. These sessions form the listening history, opened from the Library screen's header menu ("History"). The history is **read-only** — there is no UI to edit or delete a session.

**What gets tracked:**
- Which book was playing
- When playback started
- When playback stopped (continuously updated while playing)

**What doesn't get tracked:**
- Clip playback (ClipViewer, ClipEditor) — only the main player creates sessions
- Position changes or seeks — sessions record wall-clock time, not audio position

**Sessions are synced** to Google Drive, just like books and clips. Each device contributes its own sessions; conflicts resolve by whole-entity last-writer-wins — the latest version replaces the record, time ranges don't widen. Session deletions (the sub-1-second cleanup) propagate across devices via sync tombstones (see [SYNC.md](SYNC.md)). When a sync identity merge retires a duplicate book id, its sessions are re-keyed to the surviving id, touched, and re-queued for upload. (`updated_at`/`updated_by` exist on sessions purely for sync; the feature predates it.)

The system has no dedicated service — two store actions (`trackSession`, `finalizeSession`), a throttle wrapper, and direct database methods. Sessions don't need background processing, queues, or event buses.

---

## Session Lifecycle

One session is a time range: `(book_id, started_at, ended_at)`. It doesn't track position, speed, or what was skipped.

**Creation and extension.** When main-player playback is running, the store's `onAudioStatus` handler sets `currentSessionBookId` and fires `trackSession(bookId)` through a 5-second throttle. `trackSession` queries `getCurrentSession(bookId)` — the most recent session on this book whose `ended_at` is within the last **5 minutes** (hardcoded in `database.ts`, no named constant). If one exists it's extended (`ended_at` updated); otherwise a new session is created. Pause-and-resume within 5 minutes therefore extends one session instead of fragmenting the history; past the window, a fresh session starts. If the book isn't in the store, `trackSession` silently no-ops — a deliberate guard against orphaned sessions (locked by a test).

**Finalization.** The handler finalizes the active session the moment any of three conditions breaks — checked before the position-persistence guards, because book switches null `playback.uri` mid-transition:

1. status is no longer `'playing'`
2. `playback.ownerId` left `MAIN_PLAYER_OWNER_ID` (a clip component took over)
3. the playing book is no longer `currentSessionBookId` (book switch)

`finalizeSession` is immediate (not throttled). Sessions shorter than `MIN_SESSION_DURATION_MS` (1 second) are deleted and a sync `delete` is queued; the rest get a final `ended_at` and a sync `upsert`. `trackSession` queues an upsert only when it *extends* a session — a newly created session is first queued on a later extend tick or on finalization, so a session that dies before its first 5-second tick isn't worth syncing.

**No session id is held.** `currentSessionBookId` is a *book* id; `finalizeSession` re-finds the session through the same `getCurrentSession` 5-minute window. Consequences: finalize is a no-op if no session is in-window, and it operates on whatever session the window returns.

**Cross-device coupling.** `getCurrentSession` filters only on book id and window — not on device. A session synced in from another device within the last 5 minutes gets *extended* by this device rather than a new one being created (and can likewise be finalized here). Combined with whole-entity LWW this is mostly harmless, but it means session boundaries are not strictly per-device.

**Durations include paused gaps.** Displayed durations (list rows, histogram) are `ended_at − started_at`. A 4-minute pause inside the resume window is counted as listening time. This is the trade-off of the anti-fragmentation window.

---

## Integration with the Store

**Throttling.** `trackSession` is wrapped in `throttleSameArgs(fn, 5000)` and wired up in `store/index.ts` (not in the action files themselves). Audio status events fire many times per second, so without this, every event would hit the database. Unlike a plain throttle, a call with a *different* book id goes through immediately — switching books doesn't wait out the 5-second window.

**Dual writes.** Both `trackSession` and `finalizeSession` update the database and the Zustand store in the same call, keeping in-memory state in sync without re-fetching.

**Serialization.** All session operations run through a single promise chain in `store/index.ts` (`enqueueSessionOp`), so a finalize can never interleave with an in-flight track's read-then-write — the ordering hazards (a pause landing mid-track, an upsert queued after a delete) are structurally excluded.

**Failures are silent.** Session writes are fire-and-forget: `updateSessionEndedAt` is a sync method whose caller doesn't await it (errors go to `console.debug`), and `enqueueSessionOp` catches and `console.error`s. There is no user-visible failure path — a lost session write is considered acceptable.

**Refetches.** The history refetches on screen focus (`SessionsScreen` `useFocusEffect`) and whenever sync reports `sessionsChanged`.

---

## Edge Cases

### App crash during playback

If the app crashes, the session's `ended_at` reflects the last throttled update — at most 5 seconds before the crash. The session isn't lost, it just ends slightly early. On next launch, the 5-minute window will likely have passed, so a new session starts.

### Deleted books

Sessions use `LEFT JOIN files` to load book metadata. Since deleted books still have database records (soft-delete with `hidden: true`), their sessions still appear in the history with name, title, artist, and artwork preserved. The book row can be missing entirely, though — a session synced before its book, or a book id retired by a sync identity merge — so all `book_*` fields on `SessionWithBook` are nullable.

Nothing ever deletes a book's sessions: there's no FK cascade and book deletion only sets `hidden`. Sessions are permanent history.

---

## The Histogram

`SessionHistogram` shows listening time per bucket over a **fixed 10 buckets** of the selected span (day/week/month/year; default week). Bucketing details:

- A session lands wholly in the bucket of its `started_at` — one crossing midnight isn't split.
- Zero/negative durations are skipped.
- Sessions older than the 10th bucket are invisible.
- The histogram reflects the screen's current search filter.

---

## Testing

Jest: `src/store/__tests__/session.test.ts` (the only coverage of the three finalize triggers, plus serialization), `src/actions/__tests__/track_session.test.ts`, `src/actions/__tests__/finalize_session.test.ts`.

---

## File Map

```
src/actions/
  track_session.ts       → Creates or extends a session during playback
  finalize_session.ts    → Closes a session when playback stops
  fetch_sessions.ts      → Loads all sessions from database
  constants.ts           → MIN_SESSION_DURATION_MS (1000ms)

src/services/storage/
  database.ts            → getCurrentSession, createSession, updateSessionEndedAt,
                           deleteSession, getAllSessions; sync-side: getSessionById,
                           getAllSessionsRaw, restoreSessionFromBackup, touchSession

src/store/
  index.ts               → onAudioStatus finalize triggers, throttledTrackSession,
                           enqueueSessionOp, currentSessionBookId

src/components/
  SessionHistogram.tsx   → 10-bucket listening time by day/week/month/year
  SessionItem.tsx        → Single session row (duration = ended_at − started_at)
```
