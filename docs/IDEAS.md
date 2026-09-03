# Ideas & Improvements

## Features

1. **Handle dragging in Editor during live playback** — the editor timeline freezes while a handle is dragged (playback follow deliberately excludes handle drags in `engine.ts`), then jerks to catch up on release. Live-drag needs: per-tick handle recompute from absolute finger x (drag is delta-based today), per-anchor push skip (`_pushSelection` currently disables both anchors), and a product decision for the linked playhead advancing into the held handle. Middle option: keep the freeze, ease the release catch-up.


2. **Mark as finished** - ability to force-display an item as finished even if the saved position says otherwise. Separate attribute, independent of position.

## Quality of Life

1. **Animations** - add some niceties.
2. **Transcription models** - investigate if there's something more accurate/faster/lighter than whisper these days.
3. **Android auto support** - that!
4. **Tablet UI** - also that!
5. **Feedback on skip** - show a popping "+30s" sign or text (and backwards) when skipping
6. **Free whisper model to reduce memory** - `release()` is never called, so the loaded model (~465MB class) stays resident while listening. Sketch: no load at startup, init on clip save (download/wifi gating moves there), release on queue drain (+small slack); disk file always kept. Measure init time first (timing log around `initContext`). Main cost: banner + transcription-states.yaml adjust.

## Questions

- **Verify everything works with 0-length audio files, books and clips** — import, playback, slicing, transcription, sync.

