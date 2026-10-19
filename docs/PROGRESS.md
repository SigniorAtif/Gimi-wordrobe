# Progress

Build progress for the unattended run. Milestones follow SPEC §15.

| # | Milestone | Status |
|---|---|---|
| 0 | Scaffold, tokens, motion tokens, animated router shell, typed API + mock | done |
| 1 | Settings page + persistence | done |
| 2 | Hash index script, Rust scanner, library.json, fixtures | next |
| 3 | Mode C (C1 + C2) + pending bar + Apply with rollback/journal/persist + toast | todo |
| 4 | Mode A (A1 + A2), A3 detail, C3 peek, layout switch, hotkeys + conflicts | todo |
| 5 | Add flow: drag-drop, extraction, A4, C4, new-character | todo |
| 6 | First-run import + review | todo |
| 7 | Previews: archive images, drop/paste, GameBanana | todo |
| 8 | NSFW, PIN, auto re-hide, shortcuts, 1000x700 pass, motion polish | todo |
| 9 | NSIS bundle config + Windows testing guide | todo |

## How to run (Linux dev)

```
npm ci
export CARGO_TARGET_DIR=~/.cache/skin-switcher-target
npm run tauri dev                 # real app
VITE_MOCK=1 npx vite --port 1430  # browser harness with fixture data
cd src-tauri && cargo test        # core logic
```

## Known issues

- none yet
