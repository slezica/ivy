# Interface

1. X to close details dialog, chapters dialog and others
2. Mark finished and adjust auto-mark-finished time margin
3. Scroll to current chapter in chapter dialog list
4. No indication of clip being saved, if long takes time to cut, temp item should appear in clip list indicating its saving and showing what details are available ahead of time.
5. Clips with missing underlying book can't be edited (bounds), but should be partially editable (other attributes).
6. Make clip transcriptions editable when done, perhaps with re-trascribe button?

# Model

1. Session remembers start and end time of listening (book timestamps), shown in UI. Session splits if seek back too long, but tolerates going back a bit.
2. Clips maximum transcription length, generous but not infinite.

# Bugs

1. Playing very frequently results in playhead moving a bit forward, jerking back and then start smoothly playing. Probably not a bug, but a consequence of optimistic take or something semi-intended. Needs diagnosis.

2. (Unverified, I suspect stale) notification tap leads to library not player (reported S25 OneUI).

# Manual Testing

- Covers show in notification/lock screen
- OneUI: play/pause Tress ~20× with no SystemUI crash (then logs: no `Large reply transaction`)
