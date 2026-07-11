# The Playback System

A guide for Ivy's audio playback architecture.

## The Big Picture

Ivy plays audiobooks and podcast clips. Playback is backed by `react-native-track-player` (v5), which provides native audio output, background playback, and system media controls (notification, lock screen, Bluetooth).

Multiple UI components can control playback — the main PlayerScreen, ClipViewer, and ClipEditor — but only one at a time. An **ownership model** prevents them from fighting over the audio player.

The playback state in the store is deliberately minimal — it represents **hardware state** (what's loaded, where it's playing, who's controlling it), not domain state. Book metadata like title and artist aren't stored in playback; the `play()` action looks them up from the database when loading a file (for system notification display), and PlayerScreen looks them up from the `books` map (for the UI).

---

## Core Concepts

### 1. Playback state is hardware-only

```typescript
playback: {
  status: 'idle' | 'loading' | 'paused' | 'playing'
  position: number       // ms — where the playhead is
  uri: string | null     // what file is loaded
  duration: number       // ms — length of loaded file
  ownerId: string | null // who's controlling playback
}
```

This is what the audio player is physically doing right now. There's no book title, no artwork, no "currently playing book" concept here. Components that need that information look up the `Book` from the `books` map by matching `playback.uri`.

### 2. Local-first UI state

Each playback component (PlayerScreen, ClipViewer, ClipEditor) maintains its own local position state (`ownPosition`). This decouples the UI from the global store:

- When the component owns playback, it syncs `ownPosition` from global state
- When it doesn't own playback, it keeps its local position unchanged
- Seeks always update `ownPosition` immediately (optimistic), then conditionally update the player

This prevents the timeline from jumping when another component takes over playback.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                     UI Components                            │
│  PlayerScreen · ClipViewer · ClipEditor                      │
│                                                              │
│  Each has:                                                   │
│    ownPosition (local)     ← syncs from global when owner    │
│    ownerId (unique per component)                            │
└──────────┬───────────────────────────────────────────────────┘
           │ play(), pause(), seek()
           ▼
┌──────────────────────────────────────────────────────────────┐
│                     Store Actions                            │
│  loadBook · play · pause · seek · skipForward · skipBackward │
│  setSpeed · fetchPlaybackState                               │
└──────────┬───────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│                  AudioPlayerService                          │
│                                                              │
│  load(uri, metadata) → duration (ms)                         │
│  play() · pause() · seek(ms) · skip(ms)                      │
│                                                              │
│  Emits: 'status' events (position, duration, status — in ms) │
└──────────┬───────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│              react-native-track-player (v5)                  │
│  Time measured in seconds                                    │
│  Native audio engine · Background playback                   │
│  System notification · Lock screen · Bluetooth               │
└──────────────────────────────────────────────────────────────┘
```

---

## The Audio Player Service

`AudioPlayerService` wraps TrackPlayer with a clean millisecond-based API and typed events. It's the conversion boundary — it accepts and returns milliseconds, converting to/from seconds internally.

### Loading audio

`load(uri, metadata?)` is the most complex method:

1. Reset the player (unload previous track)
2. Add the new track with metadata (title, artist, artwork — used for system notification)
3. **Poll for duration** — TrackPlayer doesn't return duration immediately after adding a track. The service polls `getProgress()` every 100ms until `duration > 0`, with a 10-second timeout
4. Convert the duration from seconds to milliseconds and return it

The polling is necessary because TrackPlayer needs time to probe the audio file's headers.

### State mapping

TrackPlayer has many states (Playing, Paused, Stopped, Ready, None, Buffering, etc.). The service collapses these:

- `Playing` → `'playing'`
- Everything else → `'paused'`

The `'idle'` and `'loading'` states are managed by the store actions, not the audio service.

---

## The Ownership Model

Multiple components can control playback, but only one "owns" it at a time.

### How it works

Each playback component has a stable `ownerId`:
- PlayerScreen → `MAIN_PLAYER_OWNER_ID` (`'main'`)
- ClipViewer → `'clip-viewer-{clipId}'`
- ClipEditor → `'clip-editor-{clipId}'`

When a component calls `play()`, it passes its `ownerId`. The store records this in `playback.ownerId`. Components then check ownership before reacting to global state:

```
isOwner  = playback.ownerId === myOwnerId
isPlaying = isOwner && playback.status === 'playing'
```

### Why it matters

Without ownership, every playback component would react to every status change. If ClipViewer is playing a clip and the PlayerScreen is visible, both would think playback is theirs. The PlayerScreen's position display would jump to the clip's position.

With ownership, each component ignores global playback state unless it's the owner. Non-owners keep their own local position, undisturbed.

### Position persistence

Only the main player persists position to the database. The `onAudioStatus` handler checks:

```
if (playback.ownerId !== MAIN_PLAYER_OWNER_ID) return
```

This means clip playback (ClipViewer, ClipEditor) never overwrites the book's saved position.

### Pause on unmount

ClipViewer and ClipEditor pause playback when they unmount — but only if they still own it (`playback.ownerId === myOwnerId` at unmount time). If another component has since taken over, unmounting a clip modal leaves that playback untouched.

---

## The `play(context)` and `loadBook(context)` Actions

The most important actions. Both take `{ fileUri, position, ownerId }` (`PlayContext` is an alias of `LoadBookContext`).

`play()` is a thin wrapper: it **no-ops if a load is already in flight** (`status === 'loading'` — it must not play whatever that load ends up loading), delegates loading and seeking to `loadBook()`, then sets status to `'playing'` and calls `audio.play()`.

`loadBook()` also no-ops while loading, then branches:

1. If a different file is loaded:
   - Look up the book via `db.getBookByAnyUri(fileUri)` — checks books first, then clips (so clip playback still shows the source book's metadata on the system notification)
   - Set status to `'loading'`, clear `uri`, set ownerId
   - Call `audio.load(fileUri, metadata)` — returns duration
   - **On load failure, reset to `'idle'` with `uri = null`** (nothing is loaded, and the loading guard must not block forever), then rethrow
   - Update store with uri, duration, position, status `'paused'`
   - Seek to requested position, apply the playback rate
2. If the same file but different position:
   - Update store position, seek, apply the playback rate
3. Same file, same position:
   - Just claim ownership and apply the playback rate

`loadBook()` is also used by `initializeApplication` to auto-load the last played book without starting playback.

If `loadBook()` throws inside `play()`, the catch sets status to `'paused'` when a file is still loaded or `'idle'` otherwise — a fresh-load failure always lands on `'idle'` because `loadBook` already nulled `uri`.

### Playback speed

Each book has a per-book `speed` (integer percentage, 100 = 1.0x). `loadBook`'s `applyRate` applies it on **every** path — including same-file loads — but only when the owner is the main player; clip owners (ClipViewer, ClipEditor) always play at 1.0x. The `setSpeed` action persists a new speed to the book (queued for sync) and applies it immediately if that book is playing in the main player.

---

## The Loading State Guard

A critical detail in `onAudioStatus`: status updates are ignored while the current status is `'loading'`:

```typescript
if (state.playback.status !== 'loading') {
  state.playback.status = status.status
}
```

This prevents a race condition. When `play()` sets status to `'loading'` and then calls `audio.load()`, TrackPlayer may emit intermediate state events (like `Paused` or `Ready`). Without this guard, those events would briefly flash the UI to a paused state during what should be a loading transition.

Position updates still flow through regardless — only the status field is protected.

---

## System Media Controls

System media controls (notification, lock screen, Bluetooth) are handled by a separate **playback service** that runs in a background context.

### Notification click

Tapping the notification opens a deep link (`trackplayer://notification.click`). This behavior is split across three files: `index.js` registers the playback service, `integration.ts` defines the background event handler, and `+not-found.tsx` catches the deep link and redirects to the player tab.

---

## Edge Cases and Robustness

### Load timeout

If TrackPlayer can't return a valid duration within 10 seconds (corrupt file, unsupported format), `load()` throws. `loadBook()` catches this, resets playback to `'idle'` with `uri = null` (nothing is loaded), and rethrows.

### Skip asymmetry

Forward skip is 25 seconds, backward skip is 30 seconds. This is intentional — when rewinding to re-hear something, users typically need to go further back to get context. These values match the system notification skip intervals configured during player setup.

---

## File Map

```
src/services/audio/
  player.ts           → AudioPlayerService (TrackPlayer wrapper, ms↔s boundary)
  integration.ts      → playbackService (background remote event handler)

index.js              → Registers playback service before app loads

src/actions/
  load_book.ts        → Load file / seek / claim ownership / apply rate
  play.ts             → Thin wrapper: loadBook + play (no-op while loading)
  pause.ts            → Pause playback
  set_speed.ts        → Persist per-book speed, apply if playing in main player
  seek.ts             → Seek to position (guarded by fileUri match)
  skip_forward.ts     → Skip +25 seconds
  skip_backward.ts    → Skip -30 seconds
  fetch_playback_state.ts → Read current status into store
  constants.ts        → SKIP_FORWARD_MS (25000), SKIP_BACKWARD_MS (30000)

src/store/
  index.ts            → onAudioStatus handler, playback state, ownership
  types.ts            → PlaybackState shape

src/screens/
  PlayerScreen.tsx    → Main player (ownBook, ownPosition, adoption)

src/components/timeline/  → GPU-accelerated Skia waveform (see code for details)
```
