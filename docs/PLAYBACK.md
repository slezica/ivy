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
│  play · pause · seek · skipForward · skipBackward            │
│  fetchPlaybackState                                          │
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

---

## The `play(context)` Action

The most important action. Takes a `PlayContext`: `{ fileUri, position, ownerId }`.

1. If a different file is loaded:
   - Look up metadata via `db.getBookByAnyUri(fileUri)` — checks books first, then clips (so clip playback still shows the source book's metadata on the system notification)
   - Set status to `'loading'` and ownerId
   - Call `audio.load(fileUri, metadata)` — returns duration
   - Update store with uri, duration, position
   - Seek to requested position
2. If the same file but different position:
   - Update store position, seek
3. Set status to `'playing'`, update ownerId, call `audio.play()`

On load failure, status reverts to `'paused'` (if a file was previously loaded) or `'idle'` (if nothing was loaded).

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

If TrackPlayer can't return a valid duration within 10 seconds (corrupt file, unsupported format), `load()` throws. The `play()` action catches this and reverts the status to `'paused'` or `'idle'`.

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
  fetch_playback_state.ts → Read current status into store
  constants.ts        → SKIP_FORWARD_MS (25000), SKIP_BACKWARD_MS (30000)

src/store/
  index.ts            → onAudioStatus handler, playback state, ownership
  types.ts            → PlaybackState shape

src/screens/
  PlayerScreen.tsx    → Main player (ownBook, ownPosition, adoption)

src/components/timeline/  → GPU-accelerated Skia waveform (see code for details)
```
