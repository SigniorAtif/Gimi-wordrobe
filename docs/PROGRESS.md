# Progress

Build progress for the unattended run. Milestones follow SPEC §15.

| # | Milestone | Status |
|---|---|---|
| 0 | Scaffold, tokens, motion tokens, animated router shell, typed API + mock | done |
| 1 | Settings page + persistence | done |
| 2 | Hash index script, Rust scanner, library.json, fixtures | done |
| 3 | Mode C (C1 + C2) + pending bar + Apply with rollback/journal/persist + toast | done |
| 4 | Mode A (A1 + A2), A3 detail, C3 peek, layout switch, hotkeys + conflicts | done |
| 5 | Add flow: drag-drop, extraction, A4, C4, new-character | done |
| 6 | First-run import + review | done |
| 7 | Previews: archive images, drop/paste, GameBanana | in progress |
| 8 | NSFW, PIN, auto re-hide, shortcuts, 1000x700 pass, motion polish | backend done; UI waits for the redesign |
| 9 | NSIS bundle config + Windows testing guide | todo |

## How to run (Linux dev)

```
npm ci
export CARGO_TARGET_DIR=~/.cache/skin-switcher-target
npm run tauri dev                 # real app
VITE_MOCK=1 npx vite --port 1430  # browser harness with fixture data
cd src-tauri && cargo test        # core logic
npm run fixtures                  # regenerate fixtures/Mods
npm run e2e:build && npm run e2e  # real-app e2e via tauri-driver (needs ~/.cargo/bin/tauri-driver, WebKitWebDriver)
cd src-tauri && cargo run --example scan_dry_run -- <Mods> resources/hash_index.json   # read-only scan report
cd src-tauri && cargo run --example import_dry_run -- <Mods> <test Library>             # read-only import plan
```

## Known issues

- No .rar fixture (needs the non-free `rar` tool); .rar adding is checked on Windows (docs/WINDOWS-TESTING.md).
- "From GameBanana link" saves the link but fetches no images until M7.

## M6 notes

- First run (and Settings "Re-scan now") opens the import review instead of adopting mods silently.
- Mock harness: `?import=1` opens the review with a plan modelled on the real Mods folder.
- e2e worlds leave out the archive library unless a test asks for it; `importAll` clicks through the review.
