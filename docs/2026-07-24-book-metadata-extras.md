# Book Metadata Extras

Extract rich metadata (summary, narrator, series, …) from audio files into the book record.

## Idea

Audiobook files often carry far more metadata than Ivy reads. A Libation-exported `.m4b` embeds, among others:

- `comment` — the full publisher summary
- `composer` — the narrator
- `SERIES` / `PART` — series name and position
- `SUBTITLE`, `date`, `LANGUAGE`, `PUBLISHER`, `AUDIBLE_ASIN`

Ivy only extracts title, artist, artwork and duration (`AudioMetadataModule`). The originally considered feature — "fetch a summary from a books API" — is mostly unnecessary: the summary is already in the file, offline, with zero identity-matching problems. An API remains a possible *enrichment* later (`AUDIBLE_ASIN` would make Audnexus lookups exact), but local extraction comes first.

## New Book fields

Seven optional columns on `files`, all TEXT, null when the file doesn't provide them:

| Column | Source tag | Note |
|--------|-----------|------|
| `summary` | `comment` | Publisher description |
| `narrator` | `composer` | Audiobook convention |
| `series` | `SERIES` | |
| `part` | `PART` | TEXT, not INTEGER — parts can be "0.5" or "1-3" |
| `subtitle` | `SUBTITLE` | |
| `date` | `date` | Verbatim string ("2012", possibly full dates) |
| `language` | `LANGUAGE` | |

Plus `metadata_version INTEGER` — see lazy extraction below.

These are top-level columns, not a JSON `extras` blob: they are scalar peers of `title`/`artist`, and plausibly become user-editable later (a JSON junk drawer would make that graduation awkward). Migration cost is near-zero with the existing mechanism.

## Extraction: two sources, split by failure mode

- **`MediaMetadataRetriever` (native platform API): basics** — title, artist, artwork, duration. Unchanged. In-process, near-unbreakable; survives any ffmpeg problem.
- **ffmetadata (exec'd `libffmpeg.so`): all seven extras** — the retriever *cannot* read `comment` or custom MP4 tags at all, while the ffmetadata dump contains every tag. ffmpeg has a vendored-linking history of breaking; if it fails, extras stay null (graceful degradation) and basics are untouched.

No per-field mixing: extras come from ffmetadata, period, even where the retriever has an equivalent key (`COMPOSER`, `DATE`). One source per field group.

Chapter extraction already runs `ffmpeg -f ffmetadata` on import — extras ride the same output. As part of this work, **ffmetadata parsing moves from Kotlin to JS**: the native module shrinks to "exec ffmpeg, return raw text", and a JS service parses chapters + global tags. This makes the parsing unit-testable (it never was) and adds tag extraction without new native surface.

## Lazy extraction (backfill)

Already-imported books have local files — extras can be extracted on demand, no API and no bulk migration pass:

- On viewing book details: if `book.uri !== null` and `(metadata_version ?? 0) < EXTRACTED_METADATA_VERSION`, run extraction, persist, queue for sync.
- `metadata_version` (null = never extracted) distinguishes "never ran" from "ran, file is sparse" — a naive canary field (`summary IS NULL`) would re-run ffmpeg forever on files without a summary.
- Bumping `EXTRACTED_METADATA_VERSION` (currently 1) when the extractor learns new fields lazily re-extracts old books on next view — self-upgrading.
- On extraction failure (ffmpeg broken), nothing is persisted and `metadata_version` stays null, so it retries next time.
- New imports extract inline and stamp the version immediately.

## Sync

The seven fields + `metadata_version` join `BookBackup` as optional fields. Additive change — writer `version` bumps to 2, `version_compat` stays 1 so old readers still apply the payload (unknown fields ignored, extras read as null; see docs/SYNC.md "Payload Format Versioning").

Known caveat (accepted): whole-entity LWW means an old-app device touching a book (even just position) uploads a payload without extras, nulling them on other devices. Self-healing via lazy re-extraction where the file exists locally; otherwise fixed by upgrading both devices.

Restore-on-reimport needs no special protection: extras derive from the file content itself (same fingerprint = same tags), and they are not user-editable, so overwriting on restore is always correct.

## UI

A read-only **Book Details** dialog, opened from the book's action menu ("Details"). Shows artwork, title, author, narrator, series + part, date, language, and the summary. Opening it triggers lazy extraction when the criterion holds (brief "Analyzing file…" placeholder). Layout is a first pass — expected to iterate.

## Rejected alternatives

- **Books API as primary source** (Google Books / Open Library / Audnexus): needs network, fuzzy title/artist matching against noisy ID3 data, and confirmation UI. The data is already in the file. May return later as optional enrichment keyed by `AUDIBLE_ASIN`.
- **`extras` JSON column**: avoids migrations but is unqueryable, erodes typing, and traps future user-editable fields. Store hydrates all books to memory anyway, so per-field columns cost nothing at runtime.
- **ffmetadata as the only text-tag source** (dropping the retriever for title/artist): cleaner single-source, but puts user-critical import basics behind an exec'd binary with a real breakage history. Inverted instead: retriever for basics, ffmpeg for extras only.
- **Canary field for lazy extraction**: can't distinguish "never extracted" from "extracted, empty" — replaced by `metadata_version`.
- **Bulk backfill migration**: pointless — lazy extraction backfills organically, on books the user actually looks at.

## Implementation plan

1. `audio:` move ffmetadata parsing to JS (native returns raw text; parser unit-tested), expose global tags alongside chapters
2. `db:` migration 11 — seven extras columns + `metadata_version`; `Book` interface; `setBookExtras()`
3. `library:` extract extras on import (`load_file`)
4. `library:` `extractBookExtras` lazy action
5. `sync:` extras in `BookBackup` + `restoreBookFromBackup`
6. `ui:` Book Details dialog + menu entry
7. `docs:` BOOKS.md, SYNC.md, CLAUDE.md schema updates
