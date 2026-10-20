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
| 7 | Previews: archive images, drop/paste, GameBanana | done |
| 8 | NSFW, PIN, auto re-hide, shortcuts, 1000x700 pass, motion polish | done |
| 9 | NSIS bundle config + Windows testing guide | done (Windows build and checks pending, see WINDOWS-TESTING.md) |

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
cd src-tauri && cargo test -- --ignored live_gamebanana   # live GameBanana check (network)
```

## Windows

The Windows build and the final acceptance checks happen on Windows: follow
[docs/WINDOWS-TESTING.md](WINDOWS-TESTING.md). It lists every SPEC §16 check, the Windows-only archive paths, and the
first-run import on the real Mods folder after a backup.

## Known issues

- No .rar fixture (needs the non-free `rar` tool); .rar adding is checked on Windows (docs/WINDOWS-TESTING.md).
- Ctrl+V paste on a non-editable focus is only checked in Chromium; confirm it in WebView2 on Windows.

## UI walkthrough (mock harness, 1000x700)

Checked on screen: Pages keyboard (arrows, Enter into A2 and A3, Space picks, Esc back with focus on the card),
gallery tools (make cover, Alt+arrow and drag reorder, remove to the Recycle Bin, paste, file drop, find in mod
folder), GameBanana Retry after a failed fetch, and reduced motion (no transforms on A1/A2/A3 navigation or picks,
in both layouts).

## M6 notes

- First run (and Settings "Re-scan now") opens the import review instead of adopting mods silently.
- Mock harness: `?import=1` opens the review with a plan modelled on the real Mods folder.
- e2e worlds leave out the archive library unless a test asks for it; `importAll` clicks through the review.

## Final summary

Milestones 0–9 are on `main` (PRs #1–#15). What's covered on Linux:

- **Tests:** 134 Rust tests, 74 vitest tests, and 7/7 real-app e2e tests (tauri-driver on fixture worlds: Apply, rollback, crash recovery, add, rejected archive, first-run import, skip import). Clippy, typecheck, lint and `check:windows-core` are clean.
- **Importer dry run** on the real Mods folder, read-only, with the Mods tree and `d3dx_user.ini` byte-identical before and after:
  - Sandrone and Paimon found by hash;
  - A Teaspoon of Transcendence as Sandrone's weapon;
  - Bennett's Skyward Blade as a weapon skin;
  - Oz under Fischl;
  - Tome of the Eternal Flow as a weapon;
  - ORFix copies and desktop.ini skipped.
- **UI:** both layouts, A3, A4/C4, Settings, Setup, Import review, the PIN-gated 18+ reveal, preview states and gallery tools, and the full SPEC §12 keyboard set. The final look is the "UI refresh" (warm charcoal, jade accent, art-led cards, ambient cover colour; see DESIGN.md).
- **Reviews:** every backend milestone (M6–M9) had a separate review pass; the findings and their fixes are on each PR.

Left for Windows (docs/WINDOWS-TESTING.md): the NSIS build, every §16 check on the installed app, the .rar and non-ASCII archive paths, Ctrl+V in WebView2, auto re-hide on a real minimize, then the first-run import on the real Mods folder after a backup.

Not redone in the last pass: a frame-by-frame audit of every §7 row after the refresh (the transitions were each checked when built), and a layout redesign of Setup, Import review and A4 beyond the new tokens.
