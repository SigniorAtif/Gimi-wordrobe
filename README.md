# Skin Switcher

A Windows desktop app for picking which mod skin each Genshin Impact character wears, for
[GIMI](https://github.com/SilentNightSound/GI-Model-Importer) / [XXMI](https://github.com/SpectrumQT/XXMI-Launcher)
(3DMigoto). 3DMigoto loads every enabled mod at once, so two skins for one character fight each other. Skin Switcher
keeps exactly one active skin per character, waits until you press **Apply**, and can undo any switch that fails.

![Shelves layout (sample data)](https://raw.githubusercontent.com/SigniorAtif/Gimi-wordrobe/pr-assets/m3/shelf.png)

<sub>Shelves layout (sample data: placeholder covers, no real mod art).</sub>

<details>
<summary>More screenshots (sample data)</summary>

| | |
|---|---|
| ![Pages: home](https://raw.githubusercontent.com/SigniorAtif/Gimi-wordrobe/pr-assets/m4/a1.png) | ![Pages: character](https://raw.githubusercontent.com/SigniorAtif/Gimi-wordrobe/pr-assets/m4/a2.png) |
| ![Skin detail](https://raw.githubusercontent.com/SigniorAtif/Gimi-wordrobe/pr-assets/m4/a3.png) | ![Quick peek](https://raw.githubusercontent.com/SigniorAtif/Gimi-wordrobe/pr-assets/m4/peek.png) |
| ![Add from an archive](https://raw.githubusercontent.com/SigniorAtif/Gimi-wordrobe/pr-assets/m5/a4.png) | ![Dragging an archive](https://raw.githubusercontent.com/SigniorAtif/Gimi-wordrobe/pr-assets/m5/drag.png) |
| ![Settings](https://raw.githubusercontent.com/SigniorAtif/Gimi-wordrobe/pr-assets/m1/settings-1280.png) | ![At 1000x700](https://raw.githubusercontent.com/SigniorAtif/Gimi-wordrobe/pr-assets/m3/shelf-1000.png) |

</details>

## Features

- **Two layouts**, switchable in Settings: **Shelves** (a character grid whose cards open a shelf of skins) and
  **Pages** (a character page per character, a detail page per skin).
- **Batched Apply.** Pick skins for any number of characters, review them in the pending bar, then apply them all
  at once. Ctrl+Z undoes the last pick before applying.
- **Two ways to turn a skin off**: move it to a stash in the Library (the default, keeps its path in Mods identical
  every time) or rename it with the `DISABLED_` prefix that 3DMigoto skips.
- **In-mod toggles survive switching.** The game rewrites `d3dx_user.ini` with only the loaded mods' values, so the
  app keeps each skin's saved toggles and puts them back when the skin is turned on again.
- **Add skins from archives** (.zip, .rar, .7z): drop one on the window or use **+ Add**. Nested mods (a weapon or Oz
  inside a character skin) can become their own skins; junk files and bundled library copies are left out.
- **First-run import** of an existing Mods folder and archive library, with a review screen where you confirm every
  guess before anything moves.
- **Character detection by hash** from the GI-Model-Importer hash data, then by learned hashes, then by name.
- **Hotkey conflicts** between enabled skins show before you apply.
- **Previews** from the archive's own images, or an image you drop on the add dialog or browse to.
- **18+ skins hidden by default**. The 18+ chip in the toolbar shows or hides them.
- **Keyboard first**: type to search, arrows to move, Space to pick, Ctrl+S to apply.
- Animated throughout, with a reduced-motion mode that keeps only crossfades.

**Planned**, arriving with the UI redesign: an optional PIN for 18+ skins, the Ctrl+H reveal shortcut, automatic
re-hiding, GameBanana preview fetching and pasted-image previews.

## Safety

- Nothing changes on disk until you press Apply (or Import / Extract & add).
- Before each Apply the app re-scans Mods. If something changed outside the app, it stops and shows you the fresh
  state instead of guessing.
- Every Apply is one batch with a journal: if any step fails, the finished steps are undone. If the app is killed
  mid-way, the next start rolls the batch back.
- Folders and files the app doesn't know are never moved or renamed. Existing skin folders keep their names, so the
  game's saved toggles stay attached to them.
- Removing a skin sends its folders to the Recycle Bin. Nothing is ever hard-deleted.
- Archives are untrusted: one with an absolute path, a `..` entry, a link, a Windows device name or an absurd size is
  refused before anything is written.
- The Library must not sit inside a Mods folder, because 3DMigoto would load every stashed skin.

## Install (Windows)

Download the installer (`Skin Switcher_x.y.z_x64-setup.exe`) from the
[Releases](https://github.com/SigniorAtif/Gimi-wordrobe/releases) page. To publish one, bump the version in
`src-tauri/tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml`, then push a matching tag
(`git tag v0.2.0 && git push origin v0.2.0`); the Release workflow builds the installer and attaches it.

Or build the installer yourself:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Rustlang.Rustup
# open a new terminal, then:
npm ci
npm run tauri build
```

The per-user installer lands in `src-tauri\target\release\bundle\nsis\`. It needs no admin rights and installs to
`%LOCALAPPDATA%\Skin Switcher`. [docs/WINDOWS-TESTING.md](docs/WINDOWS-TESTING.md) walks through the build, every
acceptance check on test data, and the first import of a real Mods folder.

On first start, choose your loader (XXMI or standalone 3DMigoto), its Mods folder, and a Library folder on the same
drive (for example `D:\mods\SkinLibrary`).

## Development

The app is used on Windows; Linux is supported only for development and tests. See [SPEC.md](SPEC.md) §0.

```bash
npm ci                                            # after every switch between Windows and Linux
export CARGO_TARGET_DIR=~/.cache/skin-switcher-target   # Linux: keep build output off the shared NTFS drive
npm run tauri dev                                 # real app; point Settings at fixtures/Mods, never a real Mods folder
VITE_MOCK=1 npx vite --port 1430                  # browser harness with in-memory fixture data
(cd src-tauri && cargo test)                      # core logic: scanner, Apply/rollback, journal, archives, import
npm test                                          # UI logic (vitest)
npm run typecheck && npm run lint
npm run e2e:build && npm run e2e                  # real-app e2e through tauri-driver (Linux)
npm run fixtures                                  # regenerate fixtures/Mods and the sample archives
```

- `src-tauri/src/core/` holds all disk logic with no Tauri imports, so `cargo test` runs on either OS. Commands in
  `src-tauri/src/commands.rs` are thin wrappers.
- The UI calls one typed interface in `src/api/`, implemented by `tauri.ts` (real) and `mock.ts` (harness). The mock
  is chosen at build time and is never bundled into release builds.
- `src-tauri/resources/hash_index.json` is generated by `scripts/build-hash-index.mjs` before `dev` and `build`. It's
  derived from GPL-3.0 data, so it's gitignored and never committed.
- Progress and judgement calls: [docs/PROGRESS.md](docs/PROGRESS.md), [docs/DECISIONS.md](docs/DECISIONS.md).

## Credits

- **[GI-Model-Importer-Assets](https://github.com/SilentNightSound/GI-Model-Importer-Assets)** by SilentNightSound
  and contributors: the character, weapon and NPC hash data behind entity detection. It's GPL-3.0. This repository
  doesn't contain it; the build fetches it and generates `hash_index.json`, which an installer you build includes.
- **[3DMigoto](https://github.com/bo3b/3Dmigoto)**, **[GIMI](https://github.com/SilentNightSound/GI-Model-Importer)**
  and **[XXMI](https://github.com/SpectrumQT/XXMI-Launcher)**: the loaders this app manages mods for. The `DISABLED*`
  rule and the `d3dx_user.ini` behaviour come from 3DMigoto's source.
- **[GameBanana](https://gamebanana.com)**: the planned preview fetching uses its public API for preview images and
  mod names.
- Built with [Tauri](https://tauri.app), [React](https://react.dev), [Motion](https://motion.dev),
  [Zustand](https://zustand.docs.pmnd.rs), [Vite](https://vite.dev) and TypeScript, with the
  [Inter](https://rsms.me/inter/) typeface (SIL Open Font License, via Fontsource).
- Rust crates: [trash](https://crates.io/crates/trash) (Recycle Bin), [ureq](https://crates.io/crates/ureq)
  (downloads), [serde](https://serde.rs), [thiserror](https://crates.io/crates/thiserror), and the Tauri dialog and
  opener plugins.
- Archives are read with Windows' built-in `tar.exe` (bsdtar / [libarchive](https://libarchive.org)), with
  [7-Zip](https://www.7-zip.org) or WinRAR's UnRAR as fallbacks when installed.
- Tests use [Vitest](https://vitest.dev), [WebdriverIO](https://webdriver.io) with
  [tauri-driver](https://crates.io/crates/tauri-driver), and [tempfile](https://crates.io/crates/tempfile).

## License

No license has been chosen yet, so the code is all rights reserved by the author. The hash data the build downloads
stays under GPL-3.0 (see its repository). Mods, previews and names shown in the app belong to their authors.
