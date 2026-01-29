# The Playback System

A guide for Ivy's audio playback architecture.

## Table of Contents

1. [The Big Picture](#the-big-picture)
2. [Core Concepts](#core-concepts)
3. [Architecture Overview](#architecture-overview)
4. [The Audio Player Service](#the-audio-player-service)
5. [The Ownership Model](#the-ownership-model)
6. [Playback Actions](#playback-actions)
7. [The Event Loop](#the-event-loop)
8. [The Player Screen](#the-player-screen)
9. [The Timeline Component](#the-timeline-component)
10. [System Media Controls](#system-media-controls)
11. [Edge Cases and Robustness](#edge-cases-and-robustness)
12. [File Map](#file-map)

---

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
│  play · pause · seek · skipForward · skipBackward            │
│  syncPlaybackState                                           │
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

### 3. Milliseconds everywhere except TrackPlayer


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

### Seeking and skipping

- `seek(positionMs)` → converts to seconds, calls `TrackPlayer.seekTo()`
- `skip(offsetMs)` → gets current position in seconds, applies offset (converted from ms), clamps to `[0, duration]`

### Status events

The service subscribes to two TrackPlayer events:

- **`PlaybackState`** — player started, paused, stopped, etc. Mapped to `'playing' | 'paused'`
- **`PlaybackProgressUpdated`** — fires every 1 second during playback, with position and duration in seconds. Converted to milliseconds before emitting

Both are unified into a single `'status'` event with the `PlaybackStatus` type:

```typescript
{ status: 'playing' | 'paused', position: number, duration: number }
```

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

---

## Playback Actions

### `play(context?)`

The most important action. Two modes:

**Resume (no context):** Sets status to `'playing'`, calls `audio.play()`. Ownership unchanged.

**Play with context:** `{ fileUri, position, ownerId }`

1. If a different file is loaded:
   - Look up metadata via `db.getBookByAnyUri(fileUri)` — checks books first, then clips (so clip playback still shows the source book's metadata on the system notification)
   - Set status to `'loading'` and ownerId
   - Call `audio.load(fileUri, metadata)` — returns duration
   - Update store with uri, duration, position
   - Seek to requested position
2. If the same file but different position:
   - Update store position, seek
3. Set status to `'playing'`, call `audio.play()`

On load failure, status reverts to `'paused'` (if a file was previously loaded) or `'idle'` (if nothing was loaded).

### `pause()`

Sets status to `'paused'`, calls `audio.pause()`. Ownership is preserved — the paused component is still the owner.

### `seek(context)`

`{ fileUri, position }` — Only seeks if `fileUri` matches the currently loaded file. This prevents a stale seek from one component affecting another's playback.

### `skipForward()` / `skipBackward()`

Calls `audio.skip()` with `+25000ms` or `-30000ms`. These match the system notification skip intervals.

### `syncPlaybackState()`

Reads the current status from the audio service and writes it to the store. Used when PlayerScreen gains focus, to catch up with state changes that happened while the screen was in the background.

---

## The Event Loop

Here's the complete cycle from user action to screen update:

```
User presses Play on PlayerScreen
  ↓
play({ fileUri: book.uri, position: ownPosition, ownerId: 'main' })
  ↓
AudioPlayerService.load(uri, metadata)
  → TrackPlayer.add(track), poll for duration
  → returns duration in ms
  ↓
AudioPlayerService.seek(position)
  → TrackPlayer.seekTo(position / 1000)
  ↓
AudioPlayerService.play()
  → TrackPlayer.play()
  ↓
TrackPlayer emits PlaybackState event (state = Playing)
  ↓
AudioPlayerService maps to 'playing', emits 'status' event (ms values)
  ↓
Store's onAudioStatus handler fires:
  → Updates playback.status (unless 'loading')
  → Updates playback.position
  → If main player: updates book position in DB, tracks session
  ↓
React re-renders with new playback state
  ↓
PlayerScreen sees isOwner=true, syncs ownPosition from playback.position
  ↓
Timeline scrolls to new position

  ... 1 second later ...

TrackPlayer emits PlaybackProgressUpdated (position, duration in seconds)
  ↓
AudioPlayerService converts to ms, emits 'status' event
  ↓
Cycle repeats
```

### The loading state guard

A critical detail: `onAudioStatus` only updates `playback.status` when the current status is **not** `'loading'`:

```typescript
if (state.playback.status !== 'loading') {
  state.playback.status = status.status
}
```

This prevents a race condition. When `play()` sets status to `'loading'` and then calls `audio.load()`, TrackPlayer may emit intermediate state events (like `Paused` or `Ready`). Without this guard, those events would briefly flash the UI to a paused state during what should be a loading transition.

Position updates still flow through regardless — only the status field is protected.

---

## The Player Screen

PlayerScreen is the main playback UI. It manages its own book selection and position independently of the global playback state.

### Local state

```typescript
ownBook: Book | null       // The book this screen is showing
ownPosition: number        // The position this screen remembers
```

These are separate from `playback.uri` and `playback.position` in the store.

### Adoption

When another action loads a file targeting the main player (e.g., tapping a book in the library calls `play({ ownerId: MAIN_PLAYER_OWNER_ID })`), the PlayerScreen detects this via an effect:

```
If isOwner AND playback.uri changed → look up the book, adopt it as ownBook
```

This is how the PlayerScreen learns what to display — it doesn't drive the load, it reacts to ownership.

### Position sync

While PlayerScreen is the owner and its file is loaded, it continuously syncs `ownPosition` from `playback.position`. When it's not the owner (e.g., ClipViewer took over), it stops syncing and keeps its last known position.

### Seek behavior

When the user seeks on the timeline:

1. `ownPosition` is updated immediately (the timeline responds instantly)
2. If the screen is the owner and the file is loaded, `seek()` is called to move the actual playback position
3. If the screen is not the owner, only the local position changes (no effect on audio)

This means you can seek on the PlayerScreen while a clip is playing, and nothing happens to the clip. When the PlayerScreen reclaims ownership, it plays from the seeked position.

### Focus sync

When the PlayerScreen gains focus, it calls `syncPlaybackState()` to read the latest status from the audio service. This catches up with any state changes that happened while the screen was in the background (e.g., track finished, notification pause, Bluetooth disconnect).

---

## The Timeline Component

The timeline is a GPU-accelerated horizontal scrolling waveform rendered with Skia Canvas.

### Visual structure

```
  ┌─ time indicator (optional) ──┐
  │         12:34                │
  │                              │
  │  ▐▌ ▐▌▐▌ ▐▌▐▌ ▐▌▐▌▐▌ ▐▌▐▌    │  ← bars (decorative waveform)
  │       ▐▌ ▐▌▐▌ ▐█▐▌▐▌▐▌       │
  │  ▐▌▐▌ ▐▌▐▌ ▐▌ ▐█▐▌ ▐▌▐▌▐▌    │
  │               ╫              │  ← playhead (center-fixed, 2px)
  │               ╫              │
  │                              │
  │  ○────────────────────○      │  ← selection handles (clips only)
  └──────────────────────────────┘
```

The playhead is fixed at the center of the screen. The bars scroll behind it as time progresses. Each bar represents a 5-second segment, 4px wide with 2px gaps.

### Three-layer painting

The bars are drawn once as a single Skia path, then painted three times with different clip regions:

1. **Left color** — everything before the playhead (played portion)
2. **Right color** — everything after the playhead (unplayed portion)
3. **Selection color** — the clip's range, overwriting both left and right (clips only)

This avoids drawing each bar individually, which would be far too slow for smooth scrolling.

### Bar heights

Heights are precomputed for up to 10,000 segments using layered sine waves with pseudo-random variation. This creates a convincing waveform appearance without reading actual audio data. The heights are stored in a `Float32Array` and reused across renders.

### Physics

The timeline physics hook (`useTimelinePhysics`) handles three interaction modes:

**Pan (drag):**
- Direct 1:1 scroll mapping
- On release: if velocity exceeds threshold, start momentum
- Momentum: velocity decays at 0.95× per frame until below 0.5px/frame

**Tap:**
- Animate to the tapped position with `easeOutCubic` over 200ms

**Selection handle drag (clips):**
- Moves the start or end handle
- Minimum 1 second between handles
- Calls `onSelectionChange` with new bounds

All internal tracking uses pixel coordinates (via `timeToX`/`xToTime` conversions). React re-renders are throttled to every 50ms to maintain 60fps Skia rendering without React overhead.

### Conversion functions

```
timeToX(ms) = (ms / 5000) × 6    — 5s per segment, 6px per segment
xToTime(px) = (px / 6) × 5000
```

---

## System Media Controls

System media controls (notification, lock screen, Bluetooth) are handled by a separate **playback service** that runs in a background context.

### Registration

In `index.js`, before any React code loads:

```javascript
TrackPlayer.registerPlaybackService(() => playbackService)
```

This registers a function that handles remote events. It runs in its own JavaScript context — it doesn't have access to the store or React components.

### Remote events

The playback service handles:

| Event | Action |
|-------|--------|
| `RemotePlay` | `TrackPlayer.play()` |
| `RemotePause` | `TrackPlayer.pause()` |
| `RemoteStop` | `TrackPlayer.stop()` |
| `RemoteSeek` | `TrackPlayer.seekTo(position)` |
| `RemoteJumpForward` | Seek forward by `event.interval` |
| `RemoteJumpBackward` | Seek backward by `event.interval` |
| `RemoteNext` | Jump forward 25 seconds |
| `RemotePrevious` | Jump backward 30 seconds |

All operations happen in TrackPlayer's native seconds domain. State changes flow back to the app via the same TrackPlayer event system that the AudioPlayerService subscribes to.

### Notification metadata

When `play()` loads a file, it passes metadata (title, artist, artwork) to `audio.load()`. TrackPlayer displays this on the system notification and lock screen. If metadata isn't available, the filename is used.

### Notification click

Tapping the notification opens a deep link (`ivy://notification.click`). The `+not-found.tsx` catch-all route detects this and redirects to the player tab.

---

## Edge Cases and Robustness

### Load timeout

If TrackPlayer can't return a valid duration within 10 seconds (corrupt file, unsupported format), `load()` throws. The `play()` action catches this and reverts the status to `'paused'` or `'idle'`.

### Stale seeks

`seek()` only acts if the requested `fileUri` matches `playback.uri`. This prevents a delayed seek callback from one component affecting another component's playback.

### Loading state flicker

TrackPlayer emits multiple state events during a load (Ready, Paused, etc.). The store's `onAudioStatus` handler ignores status updates while in `'loading'` state, preventing the UI from flickering between loading and paused.

### Background playback continuity

When the app is backgrounded, TrackPlayer continues playing natively. Progress events still fire. When the app returns to foreground, `syncPlaybackState()` ensures the store catches up with the current position.

### Clip playback and book position

ClipViewer and ClipEditor use their own `ownerId`. The store's `onAudioStatus` handler only updates the book's database position when `ownerId === MAIN_PLAYER_OWNER_ID`. Clip playback never overwrites saved book positions.

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
  play.ts             → Load file / resume / claim ownership
  pause.ts            → Pause playback
  seek.ts             → Seek to position (guarded by fileUri match)
  skip_forward.ts     → Skip +25 seconds
  skip_backward.ts    → Skip -30 seconds
  sync_playback_state.ts → Read current status into store
  constants.ts        → SKIP_FORWARD_MS (25000), SKIP_BACKWARD_MS (30000)

src/store/
  index.ts            → onAudioStatus handler, playback state, ownership
  types.ts            → PlaybackState shape

src/screens/
  PlayerScreen.tsx    → Main player (ownBook, ownPosition, adoption)

src/components/timeline/
  Timeline.tsx        → GPU-accelerated Skia waveform
  useTimelinePhysics.ts → Pan, momentum, tap, selection handle gestures
  constants.ts        → Layout, physics, animation constants
  utils.ts            → timeToX, xToTime, precomputed bar heights
  index.ts            → Barrel exports
```
