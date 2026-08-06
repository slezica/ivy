# Ivy

A local-first podcast and audiobook player for Android with library management, clips with on-device automatic transcription, listening history, multi-device sync via Google Drive and a polished player UI.

![Library, player, clips and history screens](docs/screenshots.png)

### AI Notice

This project was created with assistance from Claude.


## Development

Ivy is built, tested and driven by its own command-line tool (for humans and agents) at `bin/ivy.ts`.

### Prerequisites

- Node.js
- Android Studio with SDK installed, `ANDROID_HOME` environment variable set, `adb` on PATH
- [Maestro](https://maestro.mobile.dev) — e2e tests and app driving
- `sqlite3` — the `query` command

### Setup

```bash
npm install
```

### Common commands

```bash
# Standard dev client: build, install, Metro
npm start                                

# Full toolkit reference (recommended reading, it's a powerful tool)
bin/ivy.ts help                   

# Frequent commands:
bin/ivy.ts build debug --install  # build APK + install on device
bin/ivy.ts build release          # release APK + AAB (prompts for password, or $KEYSTORE_PASSWORD)
bin/ivy.ts test                   # unit (jest) + e2e (maestro); --unit / --e2e to pick
bin/ivy.ts doctor                 # environment + built-APK report
```


## License

MIT
