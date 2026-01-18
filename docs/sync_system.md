# Understanding Ivy's Sync System

This document teaches how multi-device sync works in Ivy. Rather than just describing the implementation, we'll build up from simple ideas to the full system, exploring the problems that arise and how each piece of the design solves them.

## The Problem

You use Ivy on your phone during your commute and on your tablet at home. You want:
- Your audiobook progress to follow you between devices
- Clips you create on one device to appear on the other
- Everything to work even when you're offline

This sounds simple, but it's deceptively hard. Let's see why.

## Starting Simple: The Naive Approach

The most obvious solution: whenever you make a change, upload it. Whenever you open the app, download everything.

```
Phone makes change → Upload to cloud
Tablet opens app → Download from cloud
```

This works for a single device, but breaks immediately with two:

**Scenario:** You listen on your phone (position: 45:00), then switch to your tablet which still shows position 30:00.

1. Tablet opens, downloads phone's data → position becomes 45:00 ✓
2. You listen on tablet to 50:00
3. Phone opens, downloads... wait, what's on the cloud?

If the tablet uploaded at 50:00, great. But what if:
- Tablet was offline?
- Tablet uploaded, but phone has local changes too?
- Both devices made changes to the same clip?

We need a smarter approach.

## Concept 1: Timestamps and "Last Write Wins"

The first insight: track *when* things changed. Each entity (book, clip) has an `updated_at` timestamp that advances whenever it's modified.

```typescript
interface Book {
  id: string
  position: number
  updated_at: number  // milliseconds since epoch
  // ...
}
```

Now we can compare: if the remote version is newer than local, download it. If local is newer, upload it.

```
if (remote.updated_at > local.updated_at) → download
if (local.updated_at > remote.updated_at) → upload
if (equal) → already in sync
```

**This solves the basic case.** Phone at 45:00 has `updated_at: 1000`. Tablet advances to 50:00 with `updated_at: 2000`. Phone syncs, sees remote is newer, downloads. Done.

But there's a problem we've been ignoring...

## The Conflict Problem

**Scenario:** You edit a clip's note on your phone, and separately edit the same clip's note on your tablet. Both offline. Then both sync.

```
Phone: clip.note = "Interesting point about X"    updated_at: 1000
Tablet: clip.note = "Remember to revisit this"   updated_at: 1001
```

With pure "last write wins," the tablet's edit survives and the phone's is lost. The user did meaningful work on both devices, and we silently discarded half of it.

For some fields, this is acceptable (playback position—take the furthest). For others (notes), it's not.

**Key insight:** Conflict resolution must be field-specific, not entity-specific.

We'll return to this. First, another problem.

## The "Changed Since When?" Problem

Here's a subtle issue with our timestamp comparison:

**Scenario:**
1. Phone and tablet both have clip X with `updated_at: 1000`
2. Phone goes offline, edits clip X → `updated_at: 2000`
3. Tablet goes offline, edits clip X → `updated_at: 3000`
4. Tablet syncs first → uploads, remote now has `updated_at: 3000`
5. Phone syncs → sees remote (3000) > local (2000) → downloads tablet's version

The phone's edits are lost! Both devices changed the clip, but we only detected that remote was newer—not that *both* had changed.

**The problem:** Comparing current timestamps tells us which is newer, but not whether both changed since they last agreed.

## Concept 2: The Sync Manifest

The solution is to remember what things looked like *at the time of the last sync*. This is the **sync manifest**.

```typescript
interface SyncManifestEntry {
  entity_type: 'book' | 'clip'
  entity_id: string
  local_updated_at: number   // What was local updated_at when we last synced?
  remote_updated_at: number  // What was remote updated_at when we last synced?
  synced_at: number          // When did this sync happen?
}
```

Now we can ask better questions:

```
Has local changed since last sync?
  → local.updated_at > manifest.local_updated_at

Has remote changed since last sync?
  → remote.updated_at > manifest.remote_updated_at

Is this a conflict?
  → Both of the above are true
```

**Revisiting our scenario:**

1. Both devices sync. Manifest records `local_updated_at: 1000, remote_updated_at: 1000`
2. Phone edits → local becomes 2000, manifest still says 1000
3. Tablet edits → local becomes 3000, manifest still says 1000
4. Tablet syncs first:
   - Local (3000) > manifest.local (1000) → changed locally
   - Remote (1000) = manifest.remote (1000) → not changed remotely
   - No conflict, upload. Update manifest to `local: 3000, remote: 3000`
5. Phone syncs:
   - Local (2000) > manifest.local (1000) → changed locally
   - Remote (3000) > manifest.remote (1000) → changed remotely
   - **CONFLICT detected!** Both changed. Now we can handle it properly.

**The manifest is the key innovation.** Without it, we can only see the current state. With it, we can see *what changed* since devices last agreed.

### Why a Separate Table?

You might ask: why not add `synced_local_updated_at` columns directly to the book/clip tables?

Several reasons:
1. **Conceptual separation.** The book's data (title, position) is different from sync machinery (when did we last sync this?). Mixing them muddies the model.
2. **Backup cleanliness.** When we serialize a book to JSON for upload, we don't want sync metadata in there. The backup format should be pure data.
3. **Reset flexibility.** If sync gets corrupted, we can `DELETE FROM sync_manifest` to force a full re-sync without touching user data.

## Concept 3: The Offline Queue

Another problem: what if you're offline when you make changes?

We could just wait and sync later. But consider:

1. You create a clip offline (clip gets `updated_at: 1000`)
2. Hours pass
3. You edit the clip (clip gets `updated_at: 2000`)
4. You go online and sync

When we sync, we'll upload the clip with `updated_at: 2000`. But what if between steps 1 and 4, another device also created a clip with the same ID? (Unlikely with UUIDs, but the principle matters for edits.)

More importantly: how do we know which entities to upload? Do we scan everything every time?

The **offline queue** solves this by recording *what changed* as it happens:

```typescript
interface SyncQueueItem {
  entity_type: 'book' | 'clip'
  entity_id: string
  operation: 'upsert' | 'delete'
  queued_at: number
}
```

When you edit a clip, we immediately record "clip X needs sync." When you delete a clip, we record "clip X needs deletion from remote."

Benefits:
1. **We know exactly what to sync.** No scanning required.
2. **Deletes are tracked.** Without a queue, how would we know to delete something from remote? The local record is gone!
3. **Offline resilience.** Queue persists to SQLite. Even if the app crashes, pending changes survive.
4. **Deduplication.** Edit a clip 10 times offline? One queue entry. (We use `UNIQUE(entity_type, entity_id)` and replace on conflict.)

### Queue vs. Manifest: Different Jobs

The queue and manifest might seem redundant, but they serve different purposes:

- **Queue:** "What local operations need to reach the server?" (outbound)
- **Manifest:** "What did local and remote look like when they last agreed?" (state comparison)

You need both. The queue tells you what to push. The manifest tells you whether pulling would cause conflicts.

## Putting It Together: The Sync Algorithm

Now we can understand the full sync flow:

### Phase 1: Process the Queue

First, push all queued local changes:

```
for each queued item:
  if operation is 'upsert':
    upload entity to remote
  if operation is 'delete':
    delete entity from remote
  remove from queue on success
```

This ensures our local changes reach the server before we consider downloading.

### Phase 2: Push Remaining Changes

The queue catches changes made through the UI. But what about changes we might have missed? We do a full comparison:

```
for each local entity:
  manifest = getManifestEntry(entity)

  if no manifest:
    # Never synced before - new local entity
    upload it

  else if local.updated_at > manifest.local_updated_at:
    # Changed locally since last sync

    if remote.updated_at > manifest.remote_updated_at:
      # CONFLICT: both changed
      merged = resolveConflict(local, remote)
      upload merged
    else:
      # Only local changed
      upload it
```

### Phase 3: Pull Remote Changes

Now download anything new or changed on remote:

```
for each remote entity:
  manifest = getManifestEntry(entity)

  if no manifest:
    # Never seen before - new remote entity
    download it

  else if remote.updated_at > manifest.remote_updated_at:
    # Changed remotely since last sync

    if local.updated_at > manifest.local_updated_at:
      # Conflict - already handled in push phase
      skip
    else:
      # Only remote changed
      download it
```

### Phase 4: Update Manifest

After each upload/download, update the manifest:

```typescript
manifest.local_updated_at = entity.updated_at
manifest.remote_updated_at = remote.updated_at  // or what we just uploaded
manifest.synced_at = now
```

This "advances" our reference point so next sync knows what changed since now.

## Conflict Resolution in Detail

When both devices changed the same entity, we need to merge. The strategy depends on the field:

### Book Conflicts

| Field | Strategy | Why |
|-------|----------|-----|
| `position` | Maximum wins | If you listened to 45:00 on phone and 30:00 on tablet, you've heard up to 45:00. Taking the max preserves progress. |
| `title`, `artist`, `artwork` | Last-write-wins | Metadata edits are rare and usually intentional corrections. Recent edit is probably most accurate. |

### Clip Conflicts

| Field | Strategy | Why |
|-------|----------|-----|
| `note` | Concatenate | User wrote meaningful content on both devices. Losing either is unacceptable. We join them with a visible marker. |
| `start`, `duration` | Last-write-wins | These are precise values that can't be meaningfully merged. |
| `transcription` | Prefer non-null | Auto-generated, so keep whichever device has one. |

**Note concatenation example:**

```
Phone's note: "Key insight about the author's argument"
Tablet's note: "Compare with chapter 3"

Merged result:
"Key insight about the author's argument

--- Conflict (Jan 18, 2026) ---
Compare with chapter 3"
```

The user sees both contributions and can manually consolidate if desired.

## Edge Cases and Interesting Scenarios

### Scenario: Delete on One Device, Edit on Another

This is tricky:

1. Phone and tablet both have clip X (synced, manifest exists)
2. Phone deletes clip X (queues delete operation)
3. Tablet edits clip X (queues upsert operation)
4. Phone syncs → deletes clip X from remote, deletes manifest entry
5. Tablet syncs → ?

What happens at step 5?

- Tablet has clip X locally with edits
- Tablet queues an upsert
- Queue processing uploads clip X to remote
- Clip X is back!

Later, phone syncs again:
- Phone has no local clip X, no manifest entry
- Remote has clip X (uploaded by tablet)
- No manifest = "new remote entity" → downloads it

**Result:** The edit "wins" over the delete. The clip is resurrected.

Is this correct? It's a design choice:
- **Delete-wins** would require "tombstones" (records saying "X was deleted at time T")
- **Last-write-wins** (our approach) says the later action (edit) takes precedence

We chose last-write-wins for simplicity. If you made edits after something was deleted elsewhere, you probably want those edits kept.

### Scenario: New Device Setup

What happens when you sign into a brand new device?

1. New device has empty database, empty manifest
2. Sync runs
3. Push phase: nothing local to push
4. Pull phase: every remote entity has no manifest entry → "new remote" → download all
5. Manifest populated for all downloaded entities

The new device gets everything. Subsequent syncs are incremental.

### Scenario: Same Entity Created on Two Devices

With UUIDs, this is nearly impossible (2^122 possible values). But conceptually:

If phone creates clip A and tablet creates clip B, both get uploaded with different IDs. No conflict.

If somehow both created clip with same ID (astronomically unlikely):
- First to sync uploads it
- Second to sync sees remote exists, compares timestamps, handles as edit conflict

### Scenario: Network Failure Mid-Sync

What if we upload a clip's JSON but fail before uploading its MP3?

We handle this with **rollback**:

```typescript
try {
  jsonFileId = await upload(clip.json)
  mp3FileId = await upload(clip.mp3)
  updateManifest(...)
} catch (error) {
  if (jsonFileId && !mp3FileId) {
    // Partial upload - rollback
    await delete(jsonFileId)
  }
  // Item stays in queue for retry
}
```

The queue item isn't removed until both files succeed. Failed items retry on next sync (up to 3 attempts).

## The Complete Picture

Let's trace through a realistic multi-device session:

**Monday morning (phone, offline on subway):**
1. Listen to audiobook, position advances to 2:15:00
2. Create clip at interesting passage, add note "Great metaphor"
3. Changes queued: `[book upsert, clip upsert]`

**Monday evening (tablet, online at home):**
1. Open app, auto-sync runs
2. Downloads book (from previous session), position 1:30:00
3. Listen more, position reaches 1:45:00
4. Edit the clip's note: "Great metaphor - use in essay"
5. Changes queued and immediately synced

**Tuesday morning (phone, back online):**
1. Sync runs
2. Queue processing: uploads book (2:15:00) and clip
3. Push phase:
   - Book: local (2:15:00) > manifest.local → changed locally
   - Remote book (1:45:00) > manifest.remote → changed remotely too
   - CONFLICT: merge with max position → 2:15:00 wins, upload
4. Pull phase:
   - Clip: remote note changed, local note also changed
   - Already handled as conflict in push → notes concatenated

**Result:**
- Both devices have position 2:15:00 (furthest progress)
- Both devices have combined note: "Great metaphor\n\n--- Conflict ---\nGreat metaphor - use in essay"

## Implementation: Where Things Live

Now that you understand the concepts, here's where to find them in code:

| Concept | Location | Purpose |
|---------|----------|---------|
| Queue operations | `services/backup/queue.ts` | `queueChange()`, `processQueue()` |
| Manifest CRUD | `services/storage/database.ts` | `getManifestEntry()`, `upsertManifestEntry()` |
| Sync orchestration | `services/backup/sync.ts` | `sync()`, conflict resolution |
| Store hooks | `store/index.ts` | Queue calls in actions |
| Auto-sync | `screens/LibraryScreen.tsx` | AppState listener |

## A Note on Timestamps

The sync system relies heavily on timestamps, but there's nuance worth understanding about where these times come from and what can go wrong.

### Where Timestamps Come From

| Timestamp | Source | Set When |
|-----------|--------|----------|
| `entity.updated_at` | Device's local clock | Entity is created or modified |
| `manifest.local_updated_at` | Copied from `entity.updated_at` | After sync completes |
| `manifest.remote_updated_at` | Copied from `entity.updated_at` | After sync completes |
| `file.modifiedTime` | Google Drive's server | File is uploaded |

Notice the inconsistency: `manifest.remote_updated_at` stores our local timestamp, but we compare it against Drive's `modifiedTime` to detect remote changes. These are different clocks.

### Why This Matters (And Why It's Okay)

**The issue:** Device A uploads at local time 1000. Drive records `modifiedTime: 1003` (server time, slightly different). We store `remote_updated_at: 1000`. Next sync:

```
file.modifiedTime (1003) > manifest.remote_updated_at (1000) → true
```

We falsely think remote changed, triggering conflict detection even though nothing changed on another device.

**Why it's okay:** Our conflict resolution is *idempotent*—merging identical data produces identical data. Taking max of equal positions gives the same position. Concatenating a note with itself... well, that would be a problem, but we check `local.note !== remote.note` before concatenating.

So we over-detect conflicts slightly, but the resolution is harmless. Not elegant, but functional.

### Clock Drift Between Devices

Different devices have different clocks. Phone might think it's 1000, tablet might think it's 1005. This affects conflict detection:

**Scenario:**
1. Phone and tablet both have clip X, synced at `updated_at: 1000`
2. Phone's clock is 10 seconds behind tablet's clock
3. Both edit clip X at the "same moment"
4. Phone sets `updated_at: 2000`, tablet sets `updated_at: 2010`
5. Both sync

Who wins? Tablet, because its clock was ahead. The phone's edit is considered "older" even though it happened simultaneously.

**Tolerance:** For Ivy's use case (audiobook progress, notes), seconds or even minutes of drift don't matter much. If you're editing notes on two devices within seconds of each other, you'll get both via concatenation anyway.

Drift would be problematic for:
- Financial transactions (we'd need synchronized clocks or vector clocks)
- Real-time collaboration (we'd need operational transforms or CRDTs)

For offline-first personal data? Drift is tolerable.

### What If Time Goes Backward?

Clocks can go backward: NTP corrections, manual changes, daylight saving bugs, or restoring from backup.

**Scenario:** Device clock jumps backward from 2000 to 1500.

1. Entity was synced with `manifest.local_updated_at: 2000`
2. Clock resets to 1500
3. User edits entity → `updated_at: 1501`
4. Sync runs: `local.updated_at (1501) > manifest.local_updated_at (2000)`? **No!**
5. Local change not detected, not uploaded

**The edit is lost** (or at least, not synced until a future edit advances the timestamp past 2000).

**Mitigations we don't implement:**
- Monotonic counters instead of wall-clock time
- Detecting clock regression and forcing full sync
- Hybrid logical clocks (HLC)

**Why we accept this:** Clock regression is rare on modern phones (NTP keeps them accurate). The failure mode—a missed sync—is recoverable by making another edit. For a personal audiobook app, this tradeoff is acceptable.

### The Correct Approach (For Reference)

A more rigorous implementation would:

1. **Use the same time source for comparison.** Either:
   - Always use `updated_at` from inside the JSON (download to compare)
   - Always use Drive's `modifiedTime` (fetch after upload to store)

2. **Use monotonic version numbers** instead of wall-clock time. Each edit increments a counter. No clock drift issues.

3. **Use vector clocks** to track causality across devices. Detects true conflicts (concurrent edits) vs. false conflicts (sequential edits with clock skew).

We chose simplicity over correctness because:
- Clock issues are rare in practice
- Failure modes are recoverable
- Conflict resolution is safe (merges, doesn't discard)
- This is a personal app, not a distributed database

### Summary

| Concern | Status | Impact |
|---------|--------|--------|
| Mixed time sources | Known issue | May over-detect conflicts; resolution is safe |
| Clock drift | Tolerated | Last-write-wins may pick wrong "last"; acceptable for use case |
| Clock regression | Not handled | Edits during regression may not sync; rare, recoverable |

The timestamp handling is pragmatic, not perfect. For a personal audiobook app, pragmatic is sufficient.

## Limitations

This sync system makes deliberate tradeoffs for simplicity. Here's what it doesn't do:

### No Real-Time Sync

Changes propagate when you manually tap Sync or when the app returns to foreground. There's no push notification or WebSocket connection keeping devices in constant sync.

**Why:** Real-time sync adds significant complexity (persistent connections, handling reconnection, server infrastructure). For audiobook progress and occasional clip notes, eventual consistency on app open is sufficient.

### Audiobook Files Are Not Synced

Only metadata (position, title, etc.) and clips are synced. The actual audiobook files stay on each device.

**Why:** Audiobooks are large (often hundreds of MB). Syncing them would consume significant bandwidth and storage quota. Users typically have the same audiobook file on each device already.

**Implication:** If you archive a book on one device (deleting its file) and sync, the other device won't lose its file. Only the metadata syncs.

### No Undo for Conflict Resolution

When notes are concatenated during conflict resolution, there's no way to automatically undo that merge. The concatenated note with the conflict marker becomes the new canonical version.

**Why:** Supporting undo would require keeping conflict history, adding UI to review past conflicts, and deciding retention periods. Overkill for rare note conflicts.

**Workaround:** Users can manually edit the merged note to remove the parts they don't want.

### Single-Writer Deletes

If you delete a clip on one device and edit it on another, the edit wins (clip is resurrected). There's no way to say "this delete should be permanent."

**Why:** Permanent deletes would require tombstones with timestamps, adding complexity and storage overhead. The current behavior (edits win) errs on the side of preserving user work.

### No Selective Sync

You can't choose to sync only certain books or exclude certain clips. It's all or nothing.

**Why:** Selective sync adds UI complexity and edge cases (what happens when you de-select something that was synced?). For a personal library, full sync is typically desired.

### Queue Doesn't Persist Across Reinstalls

If you uninstall and reinstall the app, the offline queue is lost. Any unsynced changes disappear.

**Why:** The queue lives in SQLite, which is cleared on reinstall. This is standard mobile app behavior. Persisting across reinstalls would require server-side storage of pending changes.

**Mitigation:** Auto-sync on foreground means the queue is usually empty. Long periods offline with the app installed are the risk case.

## Key Takeaways

1. **Timestamps alone aren't enough.** You need to know what things looked like *when devices last agreed*, not just their current state.

2. **The manifest is the key abstraction.** It turns "which is newer?" into "what changed on each side?"—enabling true conflict detection.

3. **The queue captures intent.** Especially for deletes, where the entity itself is gone and can't tell us anything.

4. **Conflict resolution is domain-specific.** Position uses max (preserve progress), notes use concatenation (preserve work), metadata uses last-write-wins (recent correction).

5. **Simple rules, complex interactions.** Each piece is straightforward, but their interaction handles subtle scenarios correctly.

## Further Reading

- `AGENTS.md` - Quick reference for sync architecture
- `services/backup/sync.ts` - The sync implementation with detailed comments
- `services/backup/queue.ts` - Queue implementation
