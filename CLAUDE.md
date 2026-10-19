# Skin Switcher

Tauri 2 (Rust) + React/TS/Vite desktop app that switches the active Genshin mod skin for each character (XXMI / 3DMigoto).

**Read `SPEC.md` first.** It is the full build spec. The UI wireframes are rendered in `design/wireframes/*.png` (where they differ, SPEC wins; see the README there). Follow its milestone order (§15), starting with §0 prerequisites (the MSVC Build Tools and Rust are not installed yet on either OS).

Key facts:
- The app is used on **Windows only**. The machine dual-boots; Linux gets only the bare minimum to run `tauri dev` / `cargo test` against fixtures (SPEC §0). No Linux packaging or polish.
- Shared drive: `D:\` on Windows is `/run/media/atifahmed/New Volume/` on Linux (ntfs3, case-sensitive there, but treat paths case-insensitively like Windows).
- Never place fixtures or test `.ini` files inside any real `Mods` folder, because 3DMigoto loads every .ini under it.
- Real Mods folder: `D:\mods\3dmigoto\Mods` (GIMI). XXMI is not installed yet; its default is `%AppData%\XXMI Launcher\GIMI\Mods`.
- Treat the user's real Mods folder as read-only until the app's Apply/rollback is tested on fixtures. Ask before touching it.
- 3DMigoto rewrites `d3dx_user.ini` with only the loaded mods' values, so the app has to back up and restore toggle states itself (SPEC §3).
- On Linux use `bsdtar`, not `tar` (GNU tar can't read zip/rar). After switching OS, run `npm ci` (native binaries in node_modules differ).
- The GitHub repo (`SigniorAtif/Gimi-wordrobe`) is **public**. Never commit real mod files, archives, textures, preview images, a real `library.json`, or the generated `hash_index.json` (GPL-3.0 source, SPEC §5). Fixtures are tiny dummies.
- Build progress lives in `docs/PROGRESS.md`, judgement calls in `docs/DECISIONS.md`. Read them when resuming.
- Animated transitions everywhere are a top user priority (SPEC §7). Nothing should snap.
- The user picked both layouts A ("Pages") and C ("Shelves"), switchable in Settings.
