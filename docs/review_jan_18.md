# Code Review Report: Ivy

**Date:** January 18, 2026
**Reviewer:** Claude
**Scope:** Full codebase review

## Overview

Ivy is a well-structured React Native Expo app (~6,800 LOC) for audiobook/podcast playback with clips, transcription, and cloud sync. The codebase demonstrates solid architecture with clear separation of concerns. Below are opportunities for improvement classified by category.

---

## 1. Architecture

### Strengths
- Clear vertical layering: Screens → Components → Store → Services
- Singleton services with dependency injection
- Clever playback ownership model prevents multi-component conflicts
- Offline-first sync with SQLite queue persistence

### Opportunities

| Issue | Location | Description |
|-------|----------|-------------|
| **Monolithic store** | `store/index.ts` (790 lines) | All state, actions, and service initialization in one file. Actions are defined as closures inside `create()`, making them hard to test in isolation. |
| **Mixed service instantiation** | `store/index.ts:112-117` | Some services are shared singletons (`databaseService`), others are created locally (`fileStorageService`, `metadataService`). This inconsistency is confusing. |
| **Store couples to DB schema** | `store/index.ts` passim | Store directly calls `dbService.getBookByFingerprint()`, `dbService.updateClip()`, etc. Business logic (deduplication, restoration) lives in the store rather than a service layer. |
| **No domain layer** | - | Business operations like "restore archived book" span multiple files/concerns but aren't encapsulated as domain operations. |

### Recommendations
1. Extract store actions into separate modules (e.g., `store/actions/library.ts`, `store/actions/playback.ts`)
2. Unify service instantiation - all should be singletons from barrel exports
3. Consider a thin "use case" or "interactor" layer for multi-step business operations

---

## 2. Layering and Encapsulation

### Strengths
- Services don't access UI state
- Components access state only through Zustand
- Native modules wrapped in service classes

### Opportunities

| Issue | Location | Description |
|-------|----------|-------------|
| **UI component imports service directly** | `LibraryScreen.tsx:20-21` | Imports `databaseService` and `offlineQueueService` directly to check sync state, bypassing store abstraction. |
| **Throttling logic in store** | `store/index.ts:140-145` | Position sync throttling uses a closure variable. This should be in `AudioPlayerService` or a dedicated throttle utility. |
| **Timestamp comparison across layers** | `LibraryScreen.tsx:44-49` | Screen directly calls `databaseService.getLastSyncTime()` and does comparison logic that belongs in `backupSyncService`. |

### Recommendations
1. Move all sync state reads to the store's `sync` slice
2. Extract throttling into a utility or move to service layer
3. Add `shouldAttemptAutoSync()` method to `backupSyncService`

---

## 3. Code Reuse

### Strengths
- Shared components (`Header`, `IconButton`, `ActionMenu`, etc.)
- Utility functions in `utils/index.ts`
- Timeline component is highly reusable (playback + selection modes)

### Opportunities

| Issue | Location | Description |
|-------|----------|-------------|
| **Duplicated error handling patterns** | Multiple store actions | `try { ... } catch (error) { console.error(...); throw error }` repeated verbatim in many actions. |
| **Duplicated playback context logic** | `ClipViewer.tsx`, `ClipEditor.tsx` | Both components implement the same owner-state pattern: `useState(ownPosition)`, `useRef(ownerId)`, check `isOwner`, sync position on ownership. |
| **Duplicated book lookup by URI** | `store/index.ts:136`, `store/index.ts:443` | `Object.values(books).find(b => b.uri === ...)` done multiple times; could be a store selector. |

### Recommendations
1. Create a `usePlaybackOwner(id)` hook that encapsulates the ownership pattern
2. Add memoized selectors for common lookups: `getBookByUri(uri)`, `getClipsByBookId(id)`
3. Consider a `withErrorHandling()` wrapper for async store actions

---

## 4. Organization

### Strengths
- Directory structure mirrors architecture layers
- Barrel exports (`services/index.ts`) for clean imports
- Native modules properly isolated in `android/` with TypeScript wrappers

### Opportunities

| Issue | Location | Description |
|-------|----------|-------------|
| **Large files** | `store/index.ts` (790), `database.ts` (730), `sync.ts` (835), `Timeline.tsx` (481) | Several files exceed 500 lines. `database.ts` could split by entity; `sync.ts` could split push/pull phases. |
| **Types scattered** | Various | `Book`, `Clip` defined in `database.ts`; backup types in `sync.ts`; store types inline. Consider a `types/` directory. |
| **Constants in multiple places** | `store/index.ts:23-26`, `timeline/constants.ts`, `LibraryScreen.tsx:23` | App-wide constants (skip durations, throttle intervals) spread across files. |

### Recommendations
1. Split large files: `database.ts` → `database/books.ts`, `database/clips.ts`, `database/sync.ts`
2. Create `src/types/` for shared interfaces
3. Create `src/constants.ts` for app-wide magic numbers

---

## 5. Writing Style

### Strengths
- TypeScript interfaces well-defined
- Comments explaining "why" (e.g., sync timestamp limitations in `sync.ts:7-11`)
- Consistent naming conventions

### Opportunities

| Issue | Location | Description |
|-------|----------|-------------|
| **Inconsistent error handling** | Throughout | Mix of: throw and log, log and swallow, fire-and-forget with `.catch()`. No clear pattern for critical vs non-critical errors. |
| **console.log for debugging** | `store/index.ts:309-346` | Multiple `console.log()` statements in `loadFile()` that look like debugging artifacts, not observability. |
| **Magic numbers** | `sync.ts:80`, `store/index.ts:23-26` | Numbers like `30 * 1000` for throttle duration should be named constants with documentation. |
| **Implicit any in catch blocks** | Various | `catch (error)` without typing leaves `error` as `unknown`, but it's often used as `Error`. |

### Recommendations
1. Define error handling policy: distinguish recoverable vs fatal, logged vs thrown
2. Replace debug logs with structured logging or remove them
3. Extract all magic numbers to named constants with comments explaining rationale
4. Use `catch (error: unknown)` and narrow type appropriately

---

## 6. Error Handling

### Opportunities

| Issue | Location | Description |
|-------|----------|-------------|
| **Silent failures** | `store/index.ts:277-279` | File deletion failure logged but doesn't propagate. User may think archive succeeded when file still exists. |
| **No retry for critical operations** | `store/index.ts:306-432` | `loadFile()` has no retry logic if file copy fails mid-way (network storage, permissions, etc.). |
| **Error messages leak implementation** | `store/index.ts:445` | `throw new Error('No book or clip found for: ${context.fileUri}')` - exposes URI to user. |
| **Transcription queue has no timeout** | `transcription/queue.ts` | If Whisper hangs, the queue blocks forever. No watchdog or timeout. |

### Recommendations
1. Create user-facing error messages separate from internal errors
2. Add retry with exponential backoff for file operations
3. Add timeout to transcription processing
4. Consider error boundary component for graceful UI degradation

---

## 7. Navigation & Side Effects

### Opportunities

| Issue | Location | Description |
|-------|----------|-------------|
| **Navigate before async completes** | `LibraryScreen.tsx:67-68` | `loadFileWithPicker()` doesn't block navigation - router.push happens in same try block but could race. |
| **Jump-to-clip navigates optimistically** | `ClipsListScreen.tsx` | Navigates to player then loads audio - if load fails, user is on wrong screen. |

### Recommendations
1. Navigate only after async operations succeed, not in parallel
2. Consider a navigation helper that handles loading states

---

## 8. Testing & Observability

### Strengths
- Maestro e2e tests in `maestro/`
- `__DEV_resetApp` for test isolation
- Test audio file bundled for automation

### Opportunities

| Issue | Description |
|-------|-------------|
| **No unit tests** | Services and store actions have no unit tests. Only e2e coverage. |
| **No structured logging** | All logs are `console.log/error` with no log levels, no structured format, no way to filter. |
| **No analytics/metrics** | No tracking of sync failures, transcription success rate, playback errors, etc. |

### Recommendations
1. Add Jest tests for critical service methods (`database.ts` queries, `sync.ts` conflict resolution)
2. Consider a simple logger abstraction with levels (debug/info/warn/error)
3. Add basic analytics for key user flows (optional)

---

## Summary of Priorities

### High Impact
1. Split `store/index.ts` into actions modules
2. Unify service instantiation pattern
3. Move sync decision logic from UI to service
4. Add timeouts to transcription queue

### Medium Impact
1. Create `usePlaybackOwner` hook to reduce duplication
2. Split large files (`database.ts`, `sync.ts`)
3. Establish error handling policy
4. Add unit tests for sync conflict resolution

### Low Impact (Tech Debt)
1. Centralize constants
2. Remove debug logging
3. Type error catches properly
4. Create `types/` directory

---

## Conclusion

The codebase is solid and thoughtfully designed. These observations are refinements, not fundamental issues. The architecture supports the app's complexity well, and the patterns used (ownership model, offline-first sync, fingerprint deduplication) show careful consideration of real-world edge cases.
