# Ivy

A local-first podcast and audiobook player for Android with library management, clips with on-device automatic transcription, listening history, multi-device sync via Google Drive and a polished player UI.

![Player, library, clips and history screens](docs/screenshots.png)

### AI Notice

This project was created with assistance from Claude.


## Development

Ivy is built, tested and driven by its own command-line tool (for humans and agents) at `bin/ivy.ts`.

### Prerequisites

- Node.js, then `npm install` (applies the `patches/` set via patch-package)
- Android Studio with SDK installed, `ANDROID_HOME` environment variable set, `adb` on PATH
- [Maestro](https://maestro.mobile.dev) >= 2.8 — e2e tests and app driving
- `sqlite3` — the `query` command, the e2e suite's DB checks, and `test --upgrade`

### Common commands

```bash
# First run: build + install the dev client, then start Metro
bin/ivy.ts build debug --install
npm start                         # Metro only (never builds native)

# Full toolkit reference (recommended reading, it's a powerful tool)
bin/ivy.ts help

# Frequent commands:
bin/ivy.ts test                   # unit (jest) + e2e (maestro); --unit / --e2e to pick
bin/ivy.ts test --upgrade         # migration upgrade smoke test (emulator-only, destructive)
bin/ivy.ts build release          # release APK + AAB (prompts for password, or $KEYSTORE_PASSWORD)
bin/ivy.ts doctor                 # environment + built-APK report
```

Releases go through `bin/ivy.ts prepare --version X.Y.Z --changes '<markdown>'` — the full pipeline (tests, build, artifact checks, tag) in one interactive command. `build release` alone rebuilds artifacts but never tags.

Working from the dev container? The repo is a bind mount of the Mac checkout — never run Gradle in it directly; `bin/ivy.ts build` handles the isolation, and `bin/ivy.ts device connect` reaches the Mac-hosted emulator. See [CLAUDE.md](CLAUDE.md) for the full rules.

### Documentation

- [CLAUDE.md](CLAUDE.md) — project reference: structure, schema, architecture, toolkit
- Guides in `docs/`: [BOOKS](docs/BOOKS.md), [PLAYBACK](docs/PLAYBACK.md), [CLIPS](docs/CLIPS.md), [TRANSCRIPTION](docs/TRANSCRIPTION.md), [SESSIONS](docs/SESSIONS.md), [SYNC](docs/SYNC.md), [MIGRATIONS](docs/MIGRATIONS.md)
- [maestro/README.md](maestro/README.md) — e2e testing guide
- Dated design records in `docs/` (`YYYY-MM-DD-<topic>.md`), changelog in [docs/VERSIONS.md](docs/VERSIONS.md)


## License

MIT for Ivy's own code. Shipped binaries also bundle a GPL-3.0 FFmpeg runtime, so binary distributions are governed by the GPL's terms (the full text ships in the app's About screen).
