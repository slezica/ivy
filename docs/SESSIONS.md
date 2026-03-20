# The Sessions System

A guide for Ivy's listening history tracking.

## The Big Picture

Ivy automatically tracks how long the user listens to each book. Every time the user plays an audiobook in the main player, a **session** is created — a record with a start time and an end time. These sessions form the listening history, viewable from the player screen.

**What gets tracked:**
- Which book was playing
- When playback started
- When playback stopped (continuously updated while playing)

**What doesn't get tracked:**
- Clip playback (ClipViewer, ClipEditor) — only the main player creates sessions
- Position changes or seeks — sessions record wall-clock time, not audio position

**Sessions are local-only** — they're not synced to Google Drive.

---

## Core Concepts

### 1. A session is a time range

A session is just `(book_id, started_at, ended_at)`. It doesn't track position, speed, or what was skipped. It answers one question: "When and for how long did the user listen to this book?"

### 2. Sessions are extended, not duplicated

If the user pauses and resumes within 5 minutes, the existing session is extended rather than creating a new one. A quick bathroom break doesn't fragment the listening history into two entries.

### 3. Accidental sessions are cleaned up

Tapping play and immediately pausing (under 1 second) deletes the session entirely. The history only shows real listening activity.

---

## Architecture Overview

```
┌───────────────────────────────────────────────────────┐
│                    Audio Service                       │
│              emits status events                       │
└──────────┬────────────────────────────────────────────┘
           │ status: 'playing' | 'paused' | ...
           ▼
┌───────────────────────────────────────────────────────┐
│              onAudioStatus (store)                     │
│                                                       │
│  if playing:                                          │
│    set currentSessionBookId                           │
│    throttledTrackSession(bookId)  ← max once per 5s   │
│                                                       │
│  if not playing AND currentSessionBookId is set:      │
│    finalizeSession(currentSessionBookId)              │
│    clear currentSessionBookId                         │
└──────────┬─────────────────┬──────────────────────────┘
           │                 │
           ▼                 ▼
┌──────────────────┐    ┌──────────────────────┐
│  trackSession()  │    │ finalizeSession()    │
│                  │    │                      │
│  Resume or       │    │  If < 1s: delete     │
│  create session  │    │  If ≥ 1s: update     │
└──────────────────┘    │    ended_at          │
                        └──────────────────────┘
```

The system has no dedicated service — it's built from two store actions (`trackSession`, `finalizeSession`), a throttle wrapper, and direct database methods. This is appropriate for its simplicity: sessions don't need background processing, queues, or event buses.

---

## Session Lifecycle

When playback starts, `trackSession(bookId)` queries for a recent session on this book. If one exists within the 5-minute window (`SESSION_GAP_THRESHOLD_MS`), it extends that session by updating `ended_at`; otherwise it creates a new one. While playback continues, the throttle fires `trackSession` every 5 seconds to keep `ended_at` current.

When playback stops, `finalizeSession` runs immediately (not throttled). Sessions shorter than `MIN_SESSION_DURATION_MS` (1 second) are deleted; the rest get a final `ended_at` update.

---

## The 5-Minute Window

The session-extension mechanism uses `SESSION_GAP_THRESHOLD_MS` (5 minutes). When `trackSession` runs, it looks for an existing session on the same book whose `ended_at` is within this window. If found, it extends that session rather than creating a new one. If the gap has passed, a fresh session starts.

---

## Integration with the Store

**Throttling.** `trackSession` is wrapped in `throttle(fn, 5000)` and wired up in `store/index.ts` (not in the action files themselves). Audio status events fire many times per second, so without this, every event would hit the database. `finalizeSession` is not throttled — when playback stops, the session is immediately finalized with an accurate `ended_at`.

**Dual writes.** Both `trackSession` and `finalizeSession` update the database and the Zustand store in the same call, keeping in-memory state in sync without re-fetching.

---

## Edge Cases

### App crash during playback

If the app crashes, the session's `ended_at` reflects the last throttled update — at most 5 seconds before the crash. The session isn't lost, it just ends slightly early. On next launch, the 5-minute window will likely have passed, so a new session starts.

### Deleted books

Sessions use `INNER JOIN files` to load book metadata. Since deleted books still have database records (soft-delete with `hidden: true`), their sessions still appear in the history with name, title, artist, and artwork preserved.

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
                           deleteSession, getAllSessions

src/store/
  index.ts               → onAudioStatus handler, throttledTrackSession,
                           currentSessionBookId state
  types.ts               → Session state shape in AppState

src/screens/
  SessionsScreen.tsx     → History list UI
  PlayerScreen.tsx       → Clock icon navigating to sessions

src/utils/
  index.ts               → throttle(), formatTime()
```
