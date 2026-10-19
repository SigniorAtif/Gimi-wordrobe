You are building the Skin Switcher (repo "Gimi-wordrobe") end to end, on your own, while I sleep. Don't ask me questions; I won't be around to answer. Make sensible calls, write them down, and keep going until it's done.

## Read first
1. `CLAUDE.md` and all of `SPEC.md` in this repo. SPEC.md is the source of truth.
2. The wireframes: look at every image in `design/wireframes/*.png` and read `design/wireframes/README.md`, which lists where SPEC.md overrides them. Use them for layout, structure and copy.
3. If `docs/PROGRESS.md` exists, you are resuming. Continue from where it says.

## Goal
Finish milestones 0–8 of SPEC §15 on this Arch Linux machine, fully tested and merged to `main` on GitHub. For milestone 9, prepare the Windows NSIS bundle config. The Windows build and the final checks happen later, on Windows. For that, write `docs/WINDOWS-TESTING.md`: step-by-step instructions for me (install MSVC + Rust per §0, `npm ci`, `npm run tauri build`, run every §16 acceptance check on fixtures, then the first-run import against the real Mods folder).

## Environment (verified)
- Arch Linux, Hyprland (Wayland), AMD Radeon 860M. Project: `/run/media/atifahmed/New Volume/mods/skin-switcher` (NTFS; on Windows it is `D:\mods\skin-switcher`).
- Rust 1.99.1 (`source ~/.cargo/env` if cargo isn't on PATH), Node 26 + npm, bsdtar 3.8.10, gh (logged in as SigniorAtif, SSH remote), agent-browser, grim/slurp/hyprctl, WebKitWebDriver. The Tauri Linux libraries are installed.
- Run `export CARGO_TARGET_DIR=~/.cache/skin-switcher-target` in every shell that runs cargo, to keep build output off NTFS.
- Linux support is the bare minimum needed for dev and testing (SPEC §0). The app is used on Windows only.

## Hard rules
- **Never write** inside `/run/media/atifahmed/New Volume/mods/3dmigoto/`: not the Mods folder, not `d3dx_user.ini`, nothing. Read-only scans of the real Mods folder are fine and useful: check the scanner, grouping, hash detection and library detection against the real data described in §5.
- You may read and extract the real archives in `Mods/Charecters and wepon/`, but only into a test Library outside any Mods folder, e.g. `~/.cache/skin-switcher-testlib/` (about 23 GB free on /home).
- The GitHub repo is **public**. Never commit real mod files, archives, extracted textures, preview images, a real library.json, or the generated `hash_index.json` (its source is GPL-3.0; see §5). Fixtures are tiny dummies that you create under `fixtures/`.
- **Don't let a scaffolder overwrite existing files.** Run `npm create tauri-app` (React + TS + Vite) in a temp directory and copy the result in, keeping `SPEC.md`, `CLAUDE.md`, `docs/` and `.gitignore` (merge the ignore entries).
- Git: follow my global CLAUDE.md conventions. One branch per milestone, `feat/m<N>-<topic>`, off `main`. Atomic Conventional Commits with **no AI attribution lines**. Run typecheck, lint and tests before pushing. Open a PR with `gh` against `main` using the PR format from my global CLAUDE.md. Merge it yourself (`gh pr merge --merge --delete-branch`) once local checks pass, pull `main`, continue. Use the `ship` skill if it helps.

## How to work
- You lead. Doing everything in this one session is fine; context gets compacted automatically.
- You may use subagents where they clearly help:
  - well-bounded, independent chunks such as the hash-index script, the fixture generator and sample archives, or one Rust core module with its tests. Use `isolation: "worktree"` when a subagent edits code at the same time as you.
  - a review subagent (or `/code-review`) on each milestone's diff before merging.
  - Don't split work up just for the sake of it.
- Load the `impeccable` skill for UI design and motion work. SPEC §2 and §7 set the bar: a polished dark UI, and nothing snaps.
- After each milestone, update `docs/PROGRESS.md` (milestone status, what's next, known issues). Log judgement calls in `docs/DECISIONS.md`.
- If something needs me or Windows, add it to the later list (`mcp__later__add`) and to `docs/WINDOWS-TESTING.md`, then move on.
- Check things live where the spec asks for it (e.g. the GameBanana API shape, §10).

## Testing (every milestone, before merging)
- `cargo test` for the core logic. SPEC §14 lists what it covers: scanner and grouping, entity detection, hotkey overlap rules, Apply with a forced mid-batch failure → rollback, journal recovery, persist backup/restore, method migration, archive path checks.
- `npm run build` (tsc + vite) and lint must pass.
- Visual checks: `VITE_MOCK=1 npm run dev` + `agent-browser`.
  - Screenshot every screen you touched at 1280×800 and 1000×700, and look at the screenshots.
  - Check the §7 transitions with several frames per transition, check reduced-motion mode, and check there's no horizontal scroll.
- Real app: `npm run tauri dev` against `fixtures/Mods`.
  - Take a `grim` screenshot of the window.
  - From milestone 3 on, add tauri-driver e2e tests for the Apply, rollback and import flows.
- Fix what you find. Don't merge with failing checks.

## Done means
- Milestones 0–8 are merged to `main` and the tests pass.
- Every §7 row animates (checked in the browser harness).
- Every §16 acceptance check that can run on Linux passes on fixtures.
- A read-only dry run of the importer on the real Mods folder and archives groups everything correctly:
  - Sandrone detected by hash, and Paimon detected.
  - A Teaspoon of Transcendence as Sandrone's weapon, Bennett's Skyward Blade as a weapon skin, Oz under Fischl, and Tome of the Eternal Flow as a weapon.
  - The bundled ORFix copies and `desktop.ini` files skipped.
- `docs/WINDOWS-TESTING.md` is written, plus a README with how to run the app and credits.

Then write a short final summary in `docs/PROGRESS.md` and stop.
