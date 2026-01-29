# The Sessions System

A teaching guide for Ivy's listening history tracking. Start here — no code reading required.

## Table of Contents

1. [The Big Picture](#the-big-picture)
2. [Core Concepts](#core-concepts)
3. [Architecture Overview](#architecture-overview)
4. [Session Lifecycle](#session-lifecycle)
5. [The 5-Minute Window](#the-5-minute-window)
6. [Short Session Cleanup](#short-session-cleanup)
7. [Integration with the Store](#integration-with-the-store)
8. [The Sessions Screen](#the-sessions-screen)
9. [Edge Cases and Robustness](#edge-cases-and-robustness)
10. [File Map](#file-map)

---

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
└──────────┬─────────────────────────┬──────────────────┘
           │                         │
           ▼                         ▼
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

### Creation

When the audio service reports `status: 'playing'` and the main player owns playback (`ownerId === MAIN_PLAYER_OWNER_ID`):

1. The store sets `currentSessionBookId` to the playing book's ID
2. `trackSession(bookId)` is called (throttled to once per 5 seconds)
3. `trackSession` queries the database for a recent session on this book
4. If no recent session exists, a new one is created with `started_at = ended_at = now`

### Extension

While playback continues, the audio service keeps emitting status events. Every 5 seconds (throttle interval), `trackSession` fires again:

1. Queries for the current session (exists, within 5-minute window)
2. Updates `ended_at` to `now`

This keeps the session's end time current. If the app crashes, the last `ended_at` update (at most 5 seconds old) is already persisted in SQLite.

### Finalization

When the audio service reports any non-playing status (paused, stopped):

1. `finalizeSession(currentSessionBookId)` is called immediately (not throttled)
2. Looks up the current session
3. If the session lasted less than 1 second → **deleted** (accidental tap)
4. If the session lasted 1 second or more → `ended_at` updated to `now`
5. `currentSessionBookId` is cleared

---

## The 5-Minute Window

The 5-minute window is the mechanism that prevents fragmented sessions. It's implemented as a database query:

```sql
SELECT * FROM sessions
WHERE book_id = ? AND ended_at > ?
ORDER BY started_at DESC
LIMIT 1
```

Where `?` is `Date.now() - 5 * 60 * 1000` (5 minutes ago).

**How it works:**

- After finalization, a session's `ended_at` is set to the moment playback stopped
- If the user resumes the same book within 5 minutes, `getCurrentSession()` finds that session (its `ended_at` is recent enough)
- `trackSession` then extends it instead of creating a new one
- If more than 5 minutes pass, the old session falls outside the window and a new one is created

**Example timeline:**

```
10:00  Play Book A         → new session (id: abc), started_at=10:00
10:15  Pause               → finalize: ended_at=10:15, duration=15min ✓
10:17  Resume Book A       → getCurrentSession finds abc (10:15 < 2min ago)
                             extend: ended_at=10:17
10:30  Pause               → finalize: ended_at=10:30
10:50  Resume Book A       → getCurrentSession finds nothing (10:30 is 20min ago)
                             new session (id: def), started_at=10:50
```

---

## Short Session Cleanup

Sessions shorter than 1 second (`MIN_SESSION_DURATION_MS = 1000`) are deleted during finalization. This handles the common case of accidentally tapping play and immediately pausing.

The duration is calculated as `now - session.started_at` at finalization time.

---

## Integration with the Store

### State

```typescript
sessions: Record<string, SessionWithBook>  // All sessions, keyed by ID
currentSessionBookId: string | null         // Book being tracked right now
```

`currentSessionBookId` is transient — it tracks which book's session is "open" during the current playback. It's set when playback starts and cleared when it stops. This lets the `onAudioStatus` handler know which book to finalize when a non-playing status arrives.

### Main player only

Session tracking only fires when `playback.ownerId === MAIN_PLAYER_OWNER_ID`. This check happens in the `onAudioStatus` handler before any session logic runs. Clip playback (ClipViewer, ClipEditor) uses different owner IDs, so it never creates sessions.

### Throttling

`trackSession` is wrapped in a `throttle(fn, 5000)` — it executes at most once every 5 seconds. Audio status events fire frequently (multiple times per second during playback), so without throttling, every status event would trigger a database write.

The throttle silently drops calls within the interval. This means `ended_at` is at most 5 seconds behind real time, which is an acceptable trade-off for reducing database writes.

Note: `finalizeSession` is **not** throttled. When playback stops, the session is immediately finalized with an accurate `ended_at`.

### Actions

| Action | When called | What it does |
|--------|-------------|-------------|
| `trackSession(bookId)` | Every 5s while playing | Creates or extends a session |
| `finalizeSession(bookId)` | When playback stops | Cleans up or persists the session |
| `fetchSessions()` | SessionsScreen gains focus | Loads all sessions from database |

### Data flow

Both `trackSession` and `finalizeSession` update the database **and** the Zustand store in the same call. This keeps the in-memory state in sync without needing to re-fetch. `fetchSessions` is a full reload used when navigating to the history screen.

---

## The Sessions Screen

Accessible from the player screen via a clock icon in the header. The screen:

1. Calls `fetchSessions()` on every focus (ensures fresh data)
2. Sorts sessions by `started_at` descending (most recent first)
3. Renders a flat list with book artwork, title, artist, date/time, and duration

Each session item shows:
- **Title** — `book_title` if available, otherwise `book_name` (filename)
- **Artist** — if available
- **Meta line** — e.g. "Jan 28 at 3:15 PM · 45:00"

Duration is calculated as `ended_at - started_at` and formatted with `formatTime()`.

The screen uses `useFocusEffect` rather than loading once on mount. This means navigating away and back always shows the latest sessions, including any that were created while the screen was in the background.

---

## Edge Cases and Robustness

### App crash during playback

If the app crashes, the session's `ended_at` reflects the last throttled update (at most 5 seconds before the crash). The session isn't lost — it just ends slightly early. On next launch, it won't be resumed (the 5-minute window will likely have passed).

### Switching books

Playing Book A, then switching to Book B:
1. Audio status changes to non-playing (briefly) → `finalizeSession(A)`
2. Audio status changes to playing with Book B → `trackSession(B)` creates a new session

Each book gets its own session. There's no confusion because `trackSession` receives the book ID explicitly.

### Same book, different sessions

If the user plays Book A, stops for over 5 minutes, then plays Book A again, two separate sessions are created. The 5-minute window has passed, so `getCurrentSession` returns null.

### Deleted books

Sessions use `INNER JOIN files` to load book metadata. Since deleted books still have database records (soft-delete with `hidden: true`), their sessions still appear in the history. The book's name, title, artist, and artwork are preserved.

### Missing session in state

`finalizeSession` and `trackSession` both guard against the session not existing in the Zustand store (`if (session) { ... }`). This prevents errors if the in-memory state diverges from the database for any reason.

### Guard: book must exist

`trackSession` checks that the book exists in the store before creating a session. If the book was somehow removed from state between the audio event and the session creation, no session is created.

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
