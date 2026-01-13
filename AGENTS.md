# AI Agent Reference - Audio Player React Native

Quick reference guide for AI agents working on this codebase.

## Project Overview

React Native Expo app for podcast/audiobook playback with library management, clips/bookmarks, and a high-performance timeline UI.

## Tech Stack

- **Framework**: React Native 0.81.5 + Expo 54
- **State**: Zustand (v5.0.9) - single store in `src/store/index.ts`
- **Routing**: Expo Router (file-based, tabs layout)
- **Audio**: expo-audio (100ms polling interval)
- **Database**: SQLite via expo-sqlite
- **Graphics**: @shopify/react-native-skia (timeline rendering)
- **Gestures**: react-native-gesture-handler + reanimated

## Architecture

```
/src
  ├── store/index.ts          # Zustand store - master state orchestrator
  ├── services/
  │   ├── AudioService.ts     # expo-audio wrapper with polling
  │   ├── DatabaseService.ts  # SQLite operations
  │   └── FileService.ts      # Document picker integration
  ├── screens/
  │   ├── LibraryScreen.tsx   # File history/library
  │   ├── PlayerScreen.tsx    # Main player UI
  │   └── ClipsListScreen.tsx # Clip management
  ├── components/
  │   └── TimelineBar.tsx     # Skia-based timeline (most complex)
  └── theme.ts                # Color palette

/app
  └── (tabs)/
      ├── index.tsx           # Library tab
      ├── player.tsx          # Player tab
      └── clips.tsx           # Clips tab
```

## Key Files

### `src/store/index.ts`
Central state management. All state lives here:
- `player`: `{ status, position, duration, file }`
  - `status`: `'loading' | 'paused' | 'playing'` - player state enum
  - `position`, `duration`: in milliseconds
  - `file`: Active AudioFile object or null
- `clips`: Map of clip IDs to Clip objects
- `files`: Map of file URIs to AudioFile objects

Key actions: `loadFile`, `play`, `pause`, `seek`, `skipForward/Backward`, `addClip`, `updateClip`, `deleteClip`, `jumpToClip`

### `src/services/AudioService.ts`
Singleton managing expo-audio instance. Handles:
- Audio loading/playback/seeking
- 100ms position polling
- Auto-resume from saved position
- **Important:** `load()` has a 10-second timeout - will reject if player doesn't report duration within 10s
- This prevents hanging when content: URIs become invalid (common with Android content provider URIs)

### `src/services/DatabaseService.ts`
SQLite operations. Schema:
- **files**: `(uri, name, duration, position, opened_at)` - library history
- **clips**: `(id, file_uri, start, duration, note, created_at, updated_at)` - bookmarks
- **sessions**: defined but unused

### `src/components/TimelineBar.tsx`
**Most complex component** - GPU-accelerated timeline:
- Uses Skia Canvas for rendering (not React components)
- Ref-based physics for 60fps drag/flick animations
- Center-fixed playhead with scrolling content
- Draws only visible segments (not all bars)
- Gestures: drag to scrub, flick with momentum, tap to seek

### `src/components/LoadingModal.tsx`
Global modal that blocks UI during file loading:
- Watches `player.status === 'loading'`
- Shows ActivityIndicator and "Loading audio file..." message
- Transparent dark overlay prevents interaction

## Important Patterns

### Time Units
**Everything internal is milliseconds.** Convert to MM:SS format only at display boundaries.

### Service Layer
All I/O goes through service classes. Don't call expo-audio, SQLite, or DocumentPicker directly from components.

AudioService reports status as `'paused'` or `'playing'` based on player state. The store adds `'loading'` status during file load operations. **Important:** The polling callback preserves `'loading'` status - it only updates status to `'paused'`/`'playing'` when not in loading state. This prevents the polling from prematurely hiding the loading modal.

### Ref-Based Animation
`TimelineBar` uses `useRef` for animation state (not `useState`) to avoid re-renders during 60fps RAF loops.

### Skia Picture API
Timeline uses `makePicture` to record drawing commands once, then replays efficiently. Regenerated only when playback state changes.

### Tab Navigation
Player and Clips tabs are conditionally disabled until `currentFile` is loaded.

## Common Tasks

### Adding a new playback control
1. Add action to `src/store/index.ts`
2. Call `AudioService` method
3. Update `player` state in store (consider if `status` should change)
4. Add UI in `PlayerScreen.tsx`

### Adding database fields
1. Update schema in `DatabaseService.ts` `initDatabase()`
2. Add migration logic if needed
3. Update TypeScript types in store

### Modifying timeline behavior
- Visual changes: Edit Skia drawing code in `TimelineBar.tsx`
- Gesture behavior: Modify gesture handlers in same file
- Physics: Adjust friction/momentum in animation loop

### Adding new screen
1. Create in `src/screens/`
2. Add route in `app/(tabs)/`
3. Update tab bar in `app/(tabs)/_layout.tsx`

## State Flow

```
User Action → Store Action → Service Layer → Update Store State → React Re-render
```

Example: Play button
1. User taps play in `PlayerScreen`
2. Calls `store.play()`
3. Store immediately sets `player.status = 'playing'`
4. Store calls `AudioService.play()`
5. AudioService starts playback + polling
6. Polling updates `player.position` every 100ms
7. Components subscribed to store re-render

Example: Loading file
1. User picks file (from Library or Player screen)
2. Store sets `player.status = 'loading'` immediately
3. LoadingModal blocks entire UI with spinner
4. AudioService loads file asynchronously
5. When complete, store sets `player.status = 'playing'` (auto-play) and updates `player.file`
6. Screen navigates to player tab
7. Audio starts playing automatically

## Build/Run

```bash
npm start           # Start Expo dev server
npm run ios         # iOS simulator
npm run android     # Android emulator
```

## Testing Strategy

No formal tests currently. Manual testing focuses on:
- Resume playback from correct position
- Timeline scrubbing accuracy
- Clip creation/deletion
- File switching

## Known Patterns to Maintain

- All time values in milliseconds internally
- Store is single source of truth
- Services are stateless (store holds state)
- Timeline never triggers React re-renders during animation
- SQLite operations are async
- Audio position updates every 100ms
- Always set `player.status = 'loading'` at start of async file operations
- UI should check `player.status === 'loading'` to disable controls during loads
- AudioService.load() has 10s timeout to prevent hanging on invalid URIs

## Known Issues

- **Content URIs can become invalid**: Android content: URIs stored in the database may become inaccessible after the app restarts or the granting app revokes access. This causes files to fail to load from the library. The picker works because it grants fresh URIs. AudioService now times out after 10s and shows an error instead of hanging.

## Recent Changes (as of last commit)

- Refactored store structure: renamed `playback` to `player`, moved `currentFile` to `player.file`
- Replaced `isPlaying` boolean with `status` enum: `'loading' | 'paused' | 'playing'`
- Added global LoadingModal that blocks UI during file load
- Files auto-play after loading completes
- Loading a file automatically navigates to player tab
- Updated all components (PlayerScreen, TimelineBar, ClipsListScreen, tab layout) to use new structure
