# Topic

Toolkit aligned with current project-toolkit standards (canonical names, help layout).

# Settled

- File: `bin/ivy.ts` -> `bin/ivy-dev.ts`. Extension kept: tsx, tsc, eslint and jest all need it.
- Renames:
    - `prepare` -> `release`
    - `dev` -> `start`
    - `logs` -> `tail`
    - `capture [name]` -> `capture --screenshot [name]`
    - `tree [--raw]` -> `capture --layout [--raw]`
    - `state` -> `capture --state`
- No aliases for old names: single surface, old names fail with "unknown command".
- `test [cases]`: several jest patterns or maestro flows per call (was one).
- `--help` / `-h` anywhere on the line print the help; `help` command stays.
- Help: `WORKFLOW` -> `WORKFLOWS`, section order RECIPES, WORKFLOWS, GOTCHAS; `--help` listed under Global.
- Run log for releases: `log/release.txt` (was `log/prepare.txt`).
- Older dated records and VERSIONS.md keep the old names (historical).

# Deviations kept

- No `--force` on destructive commands. Standard says refuse-unless-forced; here the emulator-only guard is stricter and has no override, because the developer's phone holds real data. Emulator state is disposable, so a second gate would only add friction (e2e leaves data behind before every upgrade test).
- `bin/upgrade_scenarios.ts` stays a second file (grows forever, historical record like migrations).
- `generate`, `device` remain domain-specific commands.
