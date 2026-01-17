# Google Drive Backup

**Status: V0 Complete** ✓

## Overview

Automatic cloud backup to prevent data loss when switching phones. Users authenticate once with Google, then changes sync to a visible Drive folder.

**What gets backed up:**
- Book metadata (positions, timestamps, metadata) — JSON files
- Clip metadata + audio — JSON + MP3 pairs

**What doesn't get backed up:**
- Full audiobook files (too large, user can re-add)
- Local file paths (device-specific)

### Architecture Decisions

**Storage location:** Public Google Drive folder (`Ivy/`) visible to user. Eliminates need for separate manual export — users can browse/download backup files directly from Drive.

**File naming convention:**
```
Ivy/
  books/
    book1_1705432800000.json
    book2_1705432900000.json
  clips/
    clip4_1705433000000.json
    clip4_1705433000000.mp3
```

Files named by type + DB id + `updated_at` timestamp. Multiple versions can coexist; sync takes the latest.

**Sync semantics:**
- Last-write-wins via `updated_at` timestamp
- Backup is additive for books (archived books remain)
- Deleted clips are removed from backup
- Clip JSON + MP3 treated as atomic pair (same timestamp, uploaded together)

**Auth approach:** Google OAuth via `expo-auth-session` (cross-platform, no native modules). Scope: `drive.file` for public folder access.

### Database Changes

Two schema changes required:

1. **Remove `original_uri`** from books table — vestigial field, no longer used
2. **Rename `opened_at` → `updated_at`** on books table — clearer semantics, enables sync comparison

The `updated_at` field updates on position changes, making it suitable for sync diffing.

### New Services

```
src/services/backup/
  ├── index.ts     # Barrel exports
  ├── auth.ts      # Google OAuth (@react-native-google-signin)
  ├── drive.ts     # Drive REST API wrapper (resumable uploads)
  └── sync.ts      # Diff + upload/download orchestration
```

---

## Phase 1: Database Migration

**End state:** `original_uri` column removed, `opened_at` renamed to `updated_at`. All existing code updated. Tests passing.

**Key requirements:**
- Add migration in `DatabaseService.initialize()` to drop `original_uri` and rename column
- Update `Book` interface: remove `original_uri`, rename `opened_at` → `updated_at`
- Update all queries and methods referencing these fields
- Update `AGENTS.md` to reflect schema changes

**Files affected:**
- `src/services/storage/database.ts` — schema, interface, queries
- `src/store/index.ts` — any references to `opened_at`
- `src/screens/LibraryScreen.tsx` — if sorting by `opened_at`

---

## Phase 2: Google OAuth

**End state:** User can authenticate with Google. Access token persisted for future sessions. Auth state exposed to UI.

**Key requirements:**
- Implement `auth.ts` using `expo-auth-session` with Google provider
- Request `drive.file` scope
- Persist refresh token via `expo-secure-store`
- Expose: `signIn()`, `signOut()`, `getAccessToken()`, `isAuthenticated()`
- Handle token refresh transparently

**Integration contract for Phase 3:**
```typescript
// From auth.ts
function getAccessToken(): Promise<string | null>
function isAuthenticated(): boolean
function signIn(): Promise<boolean>
function signOut(): Promise<void>
```

---

## Phase 3: Drive API Wrapper

**End state:** Can list, upload, download, and delete files in Drive `Ivy/` folder.

**Key requirements:**
- Implement `drive.ts` as thin wrapper over Drive REST API v3
- Create `Ivy/books/` and `Ivy/clips/` folders on first sync if missing
- Operations: `listFiles(folder)`, `uploadFile(folder, name, content)`, `downloadFile(fileId)`, `deleteFile(fileId)`
- Handle binary (MP3) and text (JSON) content types
- Include `updated_at` timestamp in filename

**Integration contract for Phase 4:**
```typescript
interface DriveFile {
  id: string
  name: string        // e.g., "book1_1705432800000.json"
  mimeType: string
}

function listFiles(folder: 'books' | 'clips'): Promise<DriveFile[]>
function uploadFile(folder: 'books' | 'clips', name: string, content: string | Uint8Array): Promise<DriveFile>
function downloadFile(fileId: string): Promise<string | Uint8Array>
function deleteFile(fileId: string): Promise<void>
```

---

## Phase 4: Sync Orchestration

**End state:** Full bidirectional sync between local DB and Drive. Dev button triggers sync.

**Key requirements:**

**Diff logic:**
- Parse filenames to extract entity type, id, and timestamp
- For each local book/clip: if local `updated_at` > remote timestamp (or no remote), upload
- For each remote file: if remote timestamp > local `updated_at` (or no local), download
- Group remote files by id, take highest timestamp for comparison
- Deleted clips (local id exists in remote but not in local DB): delete from Drive

**Book JSON structure:**
```typescript
interface BookBackup {
  id: number
  name: string
  duration: number
  position: number
  updated_at: number
  title: string | null
  artist: string | null
  artwork: string | null
  file_size: number
  fingerprint: string  // base64-encoded
}
```

**Clip JSON structure:**
```typescript
interface ClipBackup {
  id: number
  source_id: number   // References book id
  start: number
  duration: number
  note: string
  transcription: string | null
  created_at: number
  updated_at: number
}
```

**Atomicity for clips:** Upload JSON and MP3 together. If either fails, retry both. Use same timestamp for both files.

**Sync function:**
```typescript
async function sync(): Promise<SyncResult>

interface SyncResult {
  uploaded: { books: number; clips: number }
  downloaded: { books: number; clips: number }
  deleted: { clips: number }
  errors: string[]
}
```

---

## Phase 5: V0 UI Integration

**End state:** Dev button in Library header triggers full sync. Shows auth prompt if needed, then syncs and reports result.

**Key requirements:**
- Add "Sync" button to Library screen dev tools (alongside Sample/Reset)
- On tap: check auth → prompt sign-in if needed → run full sync → show result toast/alert
- Simple loading state during sync

**Files affected:**
- `src/screens/LibraryScreen.tsx` — add dev button

---

## Future Work

After v0 is validated, these enhancements are planned:

1. **Auto-sync on change** — Debounced upload when book position or clip changes
2. **Periodic background sync** — Sync every N hours when app is open
3. **Settings screen** — Toggle auto-backup, sign out, view last sync time
4. **Sync status indicator** — Show sync state in UI (synced, pending, error)
5. **Conflict resolution UI** — Let user choose when timestamps are identical
6. **Old version cleanup** — Periodically delete superseded files from Drive
7. **Offline queue** — Queue changes when offline, sync when back online
8. **Progress reporting** — Show upload/download progress for large syncs
9. **Selective sync** — Choose which books/clips to include in backup
10. **iOS iCloud alternative** — Native iCloud option for users without Google accounts
