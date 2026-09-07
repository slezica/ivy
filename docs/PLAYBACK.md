# The Playback System

A guide for Ivy's audio playback architecture.

## The Big Picture

Ivy plays audiobooks and podcast clips. Playback is backed by `react-native-track-player` (v5), which provides native audio output, background playback, and system media controls (notification, lock screen, Bluetooth).

Multiple UI components can control playback — the main PlayerScreen, ClipViewer, and ClipEditor — but only one at a time. An **ownership model** prevents them from fighting over the audio player.

The playback state in the store is deliberately minimal — it represents **hardware state** (what's loaded, where it's playing, who's controlling it), not domain state. Book metadata like title and artist aren't stored in playback; `loadBook()` looks them up from the database when loading a file (for system notification display), and PlayerScreen looks them up from the `books` map (for the UI).

Related design records: [2026-07-24-sleep-timer.md](2026-07-24-sleep-timer.md), [2026-07-23-timeline-smooth-playback.md](2026-07-23-timeline-smooth-playback.md), [2026-07-25-player-clip-editor.md](2026-07-25-player-clip-editor.md), [2026-07-28-CLIP_EDITOR_PLAYBACK.md](2026-07-28-CLIP_EDITOR_PLAYBACK.md), [2026-08-08-detached-playhead.md](2026-08-08-detached-playhead.md).

---

## Core Concepts

### 1. Playback state is hardware-only

`playback` in the store (authoritative shape: `store/types.ts`, `PlaybackState`) holds status, position, uri, duration, ownerId, sleepTimer, and mainContext. Notes the type file doesn't carry:

- There's no book title, artwork, or "currently playing book" concept. Components look up the `Book` from the `books` map by matching `playback.uri`.
- `status: 'idle'` means nothing is loaded. It's reached three ways: initial state, a failed fresh load, and archiving/deleting the currently loaded book (`archive_book`/`delete_book` reset status/uri/ownerId and call `audio.unload()`).
- `mainContext` is the main player's `{ uri, position }` snapshot for ownership hand-back (see "Release on unmount"). It is never cleared after a restore — only overwritten on the next main→clip takeover. A stale value is harmless: it's only read while a non-main owner holds playback.

### 2. Local-first UI state

Each playback component (PlayerScreen, ClipViewer, ClipEditor) maintains its own local position state (`ownPosition`). This decouples the UI from the global store:

- When the component owns playback, it syncs `ownPosition` from global state
- When it doesn't own playback, it keeps its local position unchanged
- Seeks always update `ownPosition` immediately (optimistic), then conditionally update the player

This prevents the timeline from jumping when another component takes over playback.

### 3. Layering

- **UI components** (PlayerScreen, ClipViewer, ClipEditor): hold `ownPosition` and an `ownerId`, call store actions.
- **Store actions** (`loadBook`, `play`, `pause`, `seek`, `skipForward`, `skipBackward`, `setSpeed`, `setSleepTimer`, `releasePlayback`, `seekClip`, `fetchPlaybackState`): own all state transitions.
- **`AudioPlayerService`**: wraps TrackPlayer with a millisecond API; emits `'status'` events (position, duration, status — in ms).
- **react-native-track-player**: seconds, native engine, background playback, system controls.

---

## The Audio Player Service

`AudioPlayerService` wraps TrackPlayer with a clean millisecond-based API and typed events. It's the conversion boundary — it accepts and returns milliseconds, converting to/from seconds internally.

### Player setup

The service configures TrackPlayer lazily on first use (`ensureSetup`):

- `autoHandleInterruptions: true` — phone calls and audio ducking are handled natively; the store never sees them.
- `AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification` — swiping the app away stops playback.
- Capabilities: Play, Pause, SeekTo, JumpForward, JumpBackward.
- `forwardJumpInterval: 25` / `backwardJumpInterval: 30` (seconds) — the notification jump buttons, matching `SKIP_FORWARD_MS`/`SKIP_BACKWARD_MS`.
- `progressUpdateEventInterval: 1` — the origin of the **1 Hz** status cadence cited throughout the codebase.
- A "player has already been initialized" error is swallowed — the player survives dev reloads.

### Loading audio

`load(uri, metadata?)` is the most complex method:

1. Reset the player (unload previous track)
2. Add the new track with metadata (title, artist, artwork — used for system notification)
3. **Poll for duration** — TrackPlayer doesn't return duration immediately after adding a track (it needs time to probe the file's headers). The service polls `getProgress()` every 25ms until `duration > 0`, with a 10-second timeout. On timeout (corrupt file, unsupported format) `load()` throws; `loadBook()` catches, resets playback to `'idle'` with `uri = null`, and rethrows.
4. Convert the duration from seconds to milliseconds and return it

### Status events — two paths

The service emits `'status'` from two TrackPlayer events with different duration sources:

- `PlaybackProgressUpdated` (the 1 Hz tick) → `event.duration`
- `PlaybackState` (transitions) and `getStatus()` → the service's cached `currentDuration` (0 until a load completes)

This matters because `onAudioStatus` gates position persistence on `status.duration > 0` — early transition events can't write positions.

### State mapping

TrackPlayer has many states (Playing, Paused, Stopped, Ready, None, Buffering, etc.). The service collapses these:

- `Playing` → `'playing'`
- Everything else → `'paused'`

The `'idle'` and `'loading'` states are managed by the store actions, not the audio service.

---

## The Ownership Model

Multiple components can control playback, but only one "owns" it at a time. Without ownership, every playback component would react to every status change and their position displays would fight.

### How it works

Each playback component has a stable `ownerId`:
- PlayerScreen → `MAIN_PLAYER_OWNER_ID` (`'main'`)
- ClipViewer → `'clip-viewer-{clipId}'` (generated internally)
- ClipEditor → `'clip-editor-{clipId}'` (passed by ClipsListScreen when editing an existing clip), `'clip-editor-draft'` (passed by PlayerScreen when drafting)

The ownerId is a **prop** of ClipEditor — the caller owns it. This lets PlayerScreen claim ownership *on the editor's behalf* before mounting it (see "Ownership handoff" below).

When a component calls `play()`, it passes its `ownerId`. The store records this in `playback.ownerId`. Components then check ownership before reacting to global state:

```
isOwner  = playback.ownerId === myOwnerId
isPlaying = isOwner && playback.status === 'playing'
```

Non-owners ignore global playback state and keep their own local position, undisturbed.

### Position persistence

Only the main player persists position to the database. The `onAudioStatus` handler checks:

```
if (playback.ownerId !== MAIN_PLAYER_OWNER_ID) return
```

This means clip playback (ClipViewer, ClipEditor) never overwrites the book's saved position — including playback resumed from the system notification while a clip owner holds ownership.

### Release on unmount

ClipViewer and ClipEditor call `releasePlayback(myOwnerId)` when they unmount. The action no-ops unless the caller still owns playback (`playback.ownerId === myOwnerId`) — if another component has since taken over, unmounting a clip modal leaves that playback untouched. Ownership is re-checked after the internal `pause()` await, so a takeover racing the release also wins.

When the caller does still own playback, release pauses and returns ownership to the main player by restoring `playback.mainContext` — a `{ uri, position }` snapshot that `loadBook` captures whenever ownership passes from the main player to a non-main owner. The main player gets back exactly what it had — same book, same position, paused — even if the clip came from a different book or the same book at another position. This prevents orphan playback: a dismissed clip dialog can't leave its audio loaded under a dead ownerId, where the system notification could resume it with no visible component tracking it. Two soft spots: with no snapshot (nothing was ever loaded by the main player), release just pauses; and if the restore `loadBook` fails (the snapshotted book was archived/deleted), the error is swallowed — audio stays paused but ownership remains with the dismissed component.

The snapshot lives in the store rather than the dismissing component because only `loadBook` sees the exact takeover moment — the store's `playback.position` is current there (1 Hz status events plus seeks), while the database position is written only by main-player playback and can be stale after a paused scrub.

### Ownership handoff (player ↔ draft clip editor)

The player's clip button opens the draft ClipEditor with a seamless playback transition, in both directions:

- **Open:** the open is aborted while `status === 'loading'` (the claim below would no-op and the editor would open unowned). PlayerScreen first calls `fetchPlaybackState()` to read the live hardware position (store positions are up to a second stale at 1 Hz) and timestamps the capture. It then claims ownership for the editor — `play()` if playing, `loadBook()` if paused — with the same file and position. Audio never stops; the rate drops to 1x (clip owners always play at 1x). While playing, ClipEditor extrapolates its own mount latency from the capture timestamp (`initialPositionAt`) and skips its first store-position sync (that value is the stale one it extrapolated from).
- **Close (save or cancel):** PlayerScreen reads the editor's final position/state from global playback, reclaims with `MAIN_PLAYER_OWNER_ID` **before** unmounting the editor (so the editor's release-on-unmount sees it no longer owns and no-ops), then closes. The book's speed is re-applied by the main-owner claim.

Consequences: the hand-back position is the editor's playhead — scrubbing in the editor moves the book position. Sessions finalize when the editor takes over and resume on return (merged by the 5-minute resume window).

---

## The `play(context)` and `loadBook(context)` Actions

The most important actions. Both take `{ fileUri, position, ownerId }` (`PlayContext` is an alias of `LoadBookContext`).

`play()` is a thin wrapper: it **no-ops if a load is already in flight** (`status === 'loading'` — it must not play whatever that load ends up loading), delegates loading and seeking to `loadBook()`, then sets status to `'playing'` and calls `audio.play()`. One rule of its own: **play at the end restarts from the top** — if the loaded position is within `TRACK_END_TOLERANCE_MS` (250 ms) of the duration, it seeks to 0 first (a finished book or clip would otherwise resume into silence). The remote-control service mirrors the rule for media-key play, which bypasses the store (see "System Media Controls").

`loadBook()` also no-ops while loading, then branches:

1. If a different file is loaded:
   - Look up the book via `db.getBookByAnyUri(fileUri)` — checks books first, then clips (so clip playback still shows the source book's metadata on the system notification). **No matching row → throw**, before any state mutation.
   - Set status to `'loading'`, clear `uri`, set ownerId. The `uri` is nulled so in-flight 1 Hz status events can't write the incoming position onto the *previous* book.
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

Each book has a per-book `speed` (integer percentage, 100 = 1.0x). `loadBook`'s `applyRate` applies it on **every** path — including same-file loads — but only when the owner is the main player; clip owners (ClipViewer, ClipEditor) always play at 1.0x. The `setSpeed` action persists a new speed to the book (queued for sync) and applies it immediately if that book is loaded in the main player (playing or paused — the guard checks uri and ownership, not status).

### `seekClip(clipId)`

"Go to source" from the clips screen. Requires `clip.file_uri` (throws when the source is gone), then calls `play()` with the source file at `clip.start` under `MAIN_PLAYER_OWNER_ID` — it starts playback, not just navigation; the screen routes to the player afterwards.

---

## The Loading State Guard

Status updates are ignored while the current status is `'loading'`:

```typescript
if (state.playback.status !== 'loading') {
  state.playback.status = status.status
}
```

This prevents a race condition. When `play()` sets status to `'loading'` and then calls `audio.load()`, TrackPlayer may emit intermediate state events (like `Paused` or `Ready`). Without this guard, those events would briefly flash the UI to a paused state during what should be a loading transition.

Position updates still flow through regardless — only the status field is protected. The guard lives in **both** consumers of player status: the store's `onAudioStatus` handler and the `fetchPlaybackState` action.

### `fetchPlaybackState()`

Reads the hardware status into the store on demand, bypassing the 1 Hz wait. Triggers: PlayerScreen focus, app returning to foreground (AppState `active`), and the pre-handoff live-position read when opening the draft clip editor.

---

## The Sleep Timer

Design doc: [2026-07-24-sleep-timer.md](2026-07-24-sleep-timer.md).

`setSleepTimer(durationMs | null)` arms (or clears) a **wall-clock** countdown: `endsAt = now + duration`, exactly like a clock-app timer. State lives in `playback.sleepTimer`; the action factory's closure holds the scheduled timeout. On expiry: volume ramps to zero over the last `SLEEP_TIMER_FADE_MS` (10s, *included* in the interval; per-call override via `setSleepTimer(duration, fadeMs)` — the 5s test preset uses 2s), then `pause()` — global, whoever owns playback — then volume resets to full and the timer clears to off.

Rules:

- The fade ramp (`fadeOut`/`resetVolume`) lives in `AudioPlayerService` — it's a volume concern, and the ms↔seconds/TrackPlayer boundary stays there. Scheduling lives in the action.
- `fadeOut()` resolves `false` when cancelled by `resetVolume()`; the expiry callback then does nothing — a newer `setSleepTimer` call owns the state.
- Re-setting while running restarts the clock; setting during a fade cancels the fade and restores volume first.
- Pausing does not freeze the countdown. An expiry while paused is a no-op pause that still clears the timer.
- The timer is ephemeral — it does not survive app restart, and nothing is persisted.
- UI countdowns (player button "12m", dialog "12:43") are computed locally from `endsAt` with component-level intervals — the store is never ticked.

---

## System Media Controls

System media controls (notification, lock screen, Bluetooth) are handled by a separate **playback service** (`integration.ts`, registered in `index.js` before the app loads) that runs in a background context.

### Remote transport events bypass the store

Remote play (`RemotePlay`, and the play half of `RemotePlayPause`) goes through `remotePlay()`, which applies the same restart-from-the-top rule as the store's `play()` action before calling `TrackPlayer.play()`.

The handlers (`RemotePlay`, `RemotePause`, `RemotePlayPause`, `RemoteStop`, `RemoteSeek`, `RemoteJumpForward/Backward`, `RemoteNext/Previous`) call `TrackPlayer` directly — no store, no actions, no ownership checks. The store still observes the results via the normal status events. Consequences:

- A remote play while a clip owner holds playback resumes the *clip*, and no book position is persisted (the main-owner gate in `onAudioStatus` still applies).
- `RemoteJumpForward/Backward` use `event.interval` (the 25/30s setup values); `RemoteNext/Previous` reuse `SKIP_FORWARD_MS`/`SKIP_BACKWARD_MS`.
- `RemotePlayPause` is what single-button headsets and most Bluetooth controls send (`KEYCODE_MEDIA_PLAY_PAUSE`); track-player forwards it unresolved, so the handler reads `getPlaybackState()` and pauses while playing/buffering/loading, plays otherwise. The `playback-integration.yaml` e2e flow dispatches this key through the media session (bridge `media/play-pause`).

### Notification click

Tapping the notification opens a deep link (`trackplayer://notification.click`), emitted natively by TrackPlayer. `app/+not-found.tsx` catches the unmatched route and redirects to the player tab.

---

## Edge Cases and Robustness

### Skip asymmetry

Forward skip is 25 seconds (`SKIP_FORWARD_MS`), backward skip is 30 seconds (`SKIP_BACKWARD_MS`) — when rewinding to re-hear something, users typically need extra context. The same values configure the notification jump buttons (see "Player setup").

---

## Testing

Jest: `src/actions/__tests__/{play,load_book,release_playback,seek_clip,set_sleep_timer,skip}.test.ts`.
Maestro: `load-and-play.yaml`, `timeline-gestures.yaml`, `sleep-timer.yaml`, `clip-dismiss-release.yaml`.

---

## File Map

```
src/services/audio/
  player.ts           → AudioPlayerService (TrackPlayer wrapper, ms↔s boundary, setup)
  integration.ts      → playbackService (remote transport events, direct TrackPlayer)

index.js              → Registers playback service before app loads
app/+not-found.tsx    → Notification-click deep link → player tab

src/actions/
  load_book.ts        → Load file / seek / claim ownership / apply rate / mainContext snapshot
  play.ts             → Thin wrapper: loadBook + play (no-op while loading)
  pause.ts            → Pause playback
  release_playback.ts → Pause + return ownership to main player (clip dialog dismissal)
  seek_clip.ts        → "Go to source": play source book at clip.start as main player
  set_sleep_timer.ts  → Arm/clear the sleep timer (wall-clock, fade via audio service)
  set_speed.ts        → Persist per-book speed, apply if loaded in main player
  seek.ts             → Seek to position (guarded by fileUri match)
  skip_forward.ts     → Skip +SKIP_FORWARD_MS
  skip_backward.ts    → Skip -SKIP_BACKWARD_MS
  fetch_playback_state.ts → On-demand hardware status read (focus/foreground/handoff)
  constants.ts        → SKIP_FORWARD_MS (25000), SKIP_BACKWARD_MS (30000), SLEEP_TIMER_FADE_MS (10000)

src/store/
  index.ts            → onAudioStatus handler, playback state, ownership
  types.ts            → PlaybackState shape (authoritative)

src/screens/
  PlayerScreen.tsx    → Main player (ownBook, ownPosition, draft-editor handoff)
  ClipsListScreen.tsx → Passes 'clip-editor-{id}' ownerId when opening the editor

src/components/
  ClipViewer.tsx      → Clip playback owner ('clip-viewer-{clipId}')
  ClipEditor.tsx      → Clip editing owner (ownerId prop; handoff extrapolation)

src/components/timeline/  → GPU-accelerated Skia waveform (see code for details)
```

Note: during playback the timeline animates its own smooth motion from a
`playbackRate` prop; the 1 Hz position events only correct drift. See
[2026-07-23-timeline-smooth-playback.md](2026-07-23-timeline-smooth-playback.md).
