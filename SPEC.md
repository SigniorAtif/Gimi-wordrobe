# Skin Switcher: Build Spec

Personal Windows desktop app for choosing which Genshin Impact mod skin is active for each character.
XXMI / 3DMigoto loads mods from a `Mods` folder, and only ONE skin per character may be active at a
time. The app enables and disables mod folders, but to the user it should feel like choosing an outfit.
After applying, the user presses **F10** in game to reload. The app never sends keys to the game.

Design source: wireframes A and C on the "Skin Switcher — Wireframes" Claude Design canvas.
The user liked **both**, so both ship as two layout modes that can be switched in Settings (§6).
**Look at `design/wireframes/*.png` before building any screen** (all 10 boards, rendered; the board markup is in
`design/wireframes/source/`). Use them for layout, structure and copy. Where they disagree with this spec, this spec
wins; `design/wireframes/README.md` lists the differences.

> Revision notes (compared with the original Claude Design hand-off):
> - A and C are no longer merged. They are two separate layout modes with a Settings toggle.
> - Added §7 Motion design. Animated transitions everywhere are a top requirement.
> - Default disable method is now **move to Library stash**, because the user chose that.
> - Extraction uses the Windows built-in `tar.exe` instead of a bundled 7-Zip.
> - Added §0 Prerequisites, §5 real environment and import details, and the Tauri drag-drop notes.
>
> Second pass (2026-10-19, checked against the real disk, the 3DMigoto source and the GIMI repos):
> - §0: the machine dual-boots. The app ships for **Windows only**. Linux gets only a minimal dev/test mode (`tauri dev` + `cargo test` against fixtures).
> - §3: 3DMigoto drops a disabled skin's saved toggles from `d3dx_user.ini`, so the app now backs them up and restores them. Added an Apply journal for crash recovery, case-insensitive path rules and empty-folder cleanup.
> - §4/§5: entity detection now starts from a bundled **hash index** built from GI-Model-Importer-Assets. Fixed the library detection rule, the mod-root grouping rule and the archive table (`varesa_sfw.7z` doesn't exist; `desktop.ini` files and nested weapon/extra folders need handling).
> - §8: hotkey conflicts now follow 3DMigoto's real modifier and `condition` semantics. Fixed the Sandrone/Paimon examples.
> - §9/§10/§14/§16: path-traversal protection, junk-file skipping, texture-vs-preview rule, and more fixtures and acceptance checks.

---

## 0. Prerequisites & dev environment (do this first in the new session)

The machine dual-boots Windows and Arch Linux. The game, 3DMigoto/XXMI and the app are used on **Windows only**.
Linux gets the **bare minimum needed to run and test the app during development** (`npm run tauri dev`,
`cargo test`) and nothing more: no Linux packaging, no Linux polish. The project lives on the shared NTFS
drive, so both OSes see the same folder:

| | Windows | Arch Linux (dev only) |
|---|---|---|
| Shared drive | `D:\` | `/run/media/atifahmed/New Volume/` (ntfs3 mount) |
| Project | `D:\mods\skin-switcher` | `/run/media/atifahmed/New Volume/mods/skin-switcher` |
| Real Mods | `D:\mods\3dmigoto\Mods` | `/run/media/atifahmed/New Volume/mods/3dmigoto/Mods` |

**Windows** machine check (2026-10-19):

| Item | Status |
|---|---|
| Node.js v24.14 + npm | installed |
| WebView2 runtime v155 | installed |
| winget | installed |
| MSVC C++ Build Tools + Windows SDK | **missing** |
| Rust (rustup / cargo) | **missing** |

Install these. Each shows a UAC prompt. Restart the terminal afterwards so PATH updates.
```
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Rustlang.Rustup
```
Verify with `rustc --version`, `cargo --version`, then `npm create tauri-app@latest` (React + TS + Vite).
Use the `x86_64-pc-windows-msvc` toolchain (the rustup default).

**Arch Linux** machine check (2026-10-19): Node v26.11 + npm, `bsdtar` 3.8.10 (libarchive; RAR5 extraction verified),
webkit2gtk-4.1, base-devel, clang and `gh` are installed. Rust and a few Tauri libraries are **missing**. Install them (Tauri's Arch list):
```
sudo pacman -S --needed rustup webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
rustup default stable
```

Linux dev/test mode (the bare minimum; everything else is written for Windows only):
- Keep the core logic (scanner, ini/hotkey parser, Apply/rollback, method migration, archive planning, persist backup) in a Rust module with **no Tauri imports**, so `cargo test` runs on either OS. Use Windows path rules everywhere (case-insensitive compare, `\` in persist keys).
- Only two spots differ, each behind `#[cfg(windows)]` / `#[cfg(not(windows))]`:
  1. Extractor: `C:\Windows\System32\tar.exe` on Windows, `bsdtar` from PATH elsewhere (plain `tar` on Linux is GNU tar and can't read zip/rar).
  2. First-run pre-fill: the Windows paths in §5 only. On Linux, nothing is pre-filled; point Settings at `fixtures/Mods` by hand.
- Nothing else needs Linux code. The `trash` crate, the dialog/opener plugins and drag-drop already work there (trashed files land in the freedesktop trash, which is fine for fixtures).
- Test against `fixtures/` only. Never point a Linux dev build at the real Mods folder.
- **Test harness** (needed for automated testing, not Linux support):
  - **Browser fixture backend:** `src/api/mock.ts` implements the same interface as the real `src/api/tauri.ts` over in-memory fixture data. It's enabled with `VITE_MOCK=1` and must not end up in release builds. Drive it with `agent-browser` against `npm run dev`. Chromium is the same engine as WebView2, so screenshots and motion checks here are closer to Windows than the Linux Tauri window is.
  - **Real app e2e:** `tauri-driver` (`cargo install tauri-driver`) with the system `WebKitWebDriver` runs WebdriverIO tests against `npm run tauri dev` using fixtures (Apply, rollback, import).
  - **Screenshots of the real window:** `grim` with `hyprctl clients -j` for the window geometry (Hyprland on Wayland).
- Out of scope on Linux: packaging, window-manager tweaks (Hyprland tiling), WebKitGTK rendering or motion tuning, and Linux-only bugs that don't happen on Windows. Motion polish is judged on Windows (WebView2).
- Release builds and the final acceptance checks (§16) run on Windows.

Dual-boot hygiene:
- `node_modules` holds OS-specific native binaries (esbuild, rollup, the Tauri CLI). After switching OS, run `npm ci` first.
- On Linux keep Cargo's build output off the NTFS drive: `export CARGO_TARGET_DIR=~/.cache/skin-switcher-target`.
- ntfs3 on Linux is case-sensitive but Windows isn't. Never create two names that differ only in case (§3).
- The folder is a git repo with `core.fileMode=false` (ntfs3 reports every file as executable).

## 1. Stack & constraints

- **Tauri 2** (Rust backend) + **React + TypeScript + Vite** frontend. Single window.
- **Motion** (`motion` package, the library formerly called Framer Motion) for all animation. See §7.
- State management: Zustand (small and simple). Styling: CSS modules or plain CSS with design tokens. No Tailwind requirement.
- Window: default 1280×800, min 1000×700, resizable. Dark mode only for now. Mouse-first, plus the keyboard shortcuts in §12.
- Windows 10/11 only (no Linux/macOS build, see §0). No telemetry, no accounts. Fully offline except optional GameBanana fetches and the optional hash index update (§5).
- Project lives at `D:\mods\skin-switcher`. **Never** put the project, fixtures or test .ini files inside a `Mods` folder, because 3DMigoto would load them into the game.
- Deleting anything goes to the **Recycle Bin** (`trash` crate). Never hard delete.
- The app does not need admin. Both Mods paths are user-writable.

## 2. Visual style

- Polished dark UI: warm charcoal layered surfaces (3 elevation steps, OKLCH, low chroma), subtle 1px borders, shadows only for floating things, rounded corners (cards 14px, buttons 10px), and varied spacing.
- One accent colour, jade. Use it only for active state, focus rings and the primary button. Yellow for PENDING, red for conflict and 18+.
- Ambient art colour: the active cover's dominant colour glows softly behind the open shelf, the A2 header and the A3 detail, without hurting text contrast (docs/DESIGN.md).
- Typography: Inter Variable for UI text, Bricolage Grotesque Variable for names and titles, both bundled locally (offline). Headings step 1.25x. Use tabular numbers for counts.
- Skin cover images are the visual hero: 3:4, object-fit cover. Skin cards are cover-led with the name on a scrim; Pages cards use the active cover as a full backdrop.
- Wireframes are layout only. Don't copy their amber annotation colour. No official game logos or branding.

## 3. How enable/disable works (core mechanic)

Two methods, chosen in Settings. **Default = `move`** (the user's choice):

- **move (default):** inactive skins live in `<Library>/stash/<relative path>` and get moved into `Mods/<relative path>` when activated. The relative path stays **identical** in both places. This keeps the persist keys in `d3dx_user.ini` stable, because they are keyed by the lowercased ini path, e.g. `$\mods\sandrone_marionette_by_neyori\outfit\sandrone.ini\body`. Stable keys alone are not enough to keep the user's in-mod toggles, though. See "In-mod toggle states" below.
- **prefix:** 3DMigoto/XXMI skip any folder **or file** matching `DISABLED*`. `d3dx.ini` contains `exclude_recursive = DISABLED*`; verify the XXMI GIMI config has the same rule. Active: `Mods/Furina/Remembrance/`. Inactive: `Mods/Furina/DISABLED_Remembrance/`.
- The exclude match is a **case-insensitive** glob on each file and folder name (3DMigoto compiles it with `PCRE2_CASELESS`), and no underscore is needed: `DISABLEDVaresa.ini`, `disabled_x/` and `DISABLED_Includes.ini` are all skipped. The scanner must use the same rule. The app itself always writes `DISABLED_` in uppercase.
- **Existing folders are never renamed or reorganised**, because that would change their persist keys. New skins added from archives go to `Mods/<Entity name>/<Skin name>/` (mirrored under `stash/` in move mode).
- After moving a skin out, delete parent folders under Mods that became completely empty (e.g. `Mods/Furina/` once all Furina skins are stashed). Record those deletions in the batch so a rollback recreates them, and recreate the parent on activation.
- Compare paths **case-insensitively** (Windows rules) for collisions and lookups, even when tests run on Linux. Refuse a target that differs from an existing name only by case.
- The Library and Mods should be on the same drive so a move is an instant rename. If they're on different drives, fall back to copy + verify + delete, and show progress.
- **Apply** is a batch. Compute the diff between the current state on disk and the user's pending picks, run all renames/moves, then verify. On any failure, roll back the operations already done and show the error. Never leave two skins of one entity enabled.
- Before applying, re-scan the disk. If something changed outside the app, show "Mods folder changed outside the app — re-scanned" and keep the user's pending picks where possible.
- If a rename fails because files are locked, retry once, then report which folder failed.
- **Apply journal:** before running a batch, write `<Library>/apply-journal.json` with the planned operations and mark each one as it completes. Delete the journal on success. If the app starts and finds a journal, the last Apply was interrupted (crash, power loss): roll back the completed operations, re-scan, and tell the user.
- Switching the disable method in Settings migrates every inactive skin, in one batch with rollback.

### In-mod toggle states (`d3dx_user.ini`)

Verified in the 3DMigoto source (`IniHandler.cpp`: `SavePersistentSettings`, `ReloadConfig`; `D3D11Wrapper.cpp` on unload):
the game **rewrites the whole `d3dx_user.ini` from memory** on every F10 (when any value changed) and on game exit, and it
writes only the variables of inis that are **currently loaded**. A disabled skin's saved toggles (e.g. Sandrone `hat = 2`)
therefore disappear the next time the game exits. The app keeps its own copy:

- The file sits next to the Mods folder: `D:\mods\3dmigoto\d3dx_user.ini` for 3DMigoto, `%AppData%\XXMI Launcher\GIMI\d3dx_user.ini` for XXMI.
- Whenever the app reads the disk (scan, before Apply), copy each active skin's lines into `Skin.persist`. A line belongs to a skin when its key starts with `$\mods\<one of the skin's folders, lowercased, backslashes>\`.
- When Apply activates a skin, merge its saved lines back into `d3dx_user.ini`: back up to `.bak`, keep every other line as it is, match keys case-insensitively, write atomically.
- Never touch keys under explicit namespaces such as `$\global\healthbar\health`; those belong to libraries.
- This is best effort. If the game is running and the user changed a toggle since the last F10, the game's own save on F10 overwrites the restored lines. Don't build anything bigger than this to work around it.

## 4. Data model

Stored at `<Library>/library.json`, with previews in `<Library>/previews/<skinId>/`. Write atomically (temp file + rename) and keep `library.json.bak`.

```ts
type Category = "character" | "weapon" | "extra";

interface Entity {            // a character, weapon or extra (e.g. "Oz")
  id: string;                 // slug, e.g. "furina"
  name: string;               // "Furina"
  category: Category;
  portrait?: string;          // path under Library
  parentId?: string;          // extras can belong to a character (Oz -> fischl)
  aliases?: string[];         // other spellings seen in folder/archive names ("Benny", "Veresa", "Neuvilette")
  skinIds: string[];
}

interface Skin {
  id: string;
  entityId: string;
  name: string;               // "Remembrance"
  author?: string;
  version?: string;           // from GameBanana or the user, shown in A3
  folders: string[];          // one or more mod roots, relative to Mods (a skin can span several, e.g. Face/ + Outfit/)
  nsfw: boolean;
  gameBananaUrl?: string;
  sourceArchive?: string;     // original archive file name, for reference
  previews: { file: string; source: "gamebanana" | "archive" | "user" }[]; // first = cover
  hotkeys: Hotkey[];          // parsed from .ini; labels user-editable
  hashes: string[];           // every [TextureOverride*] hash in its inis: identity fingerprint for entity detection (§5)
  persist?: Record<string, number>; // backed-up d3dx_user.ini lines, full key -> value (§3)
  notes?: string;
  addedAt: string;
}

interface Hotkey {
  keys: string;               // raw value from the ini, e.g. "no_modifiers 6"
  label: string;
  kind: "toggle" | "cycle" | "hold" | "unknown";
  gated: boolean;             // has a `condition` (usually "$active == 1"), see §8
  section: string;
  iniFile: string;
}

interface Settings {
  activeLoader: "xxmi" | "3dmigoto";
  modsPath: { xxmi?: string; "3dmigoto"?: string };
  libraryPath: string;
  disableMethod: "move" | "prefix";
  layout: "pages" | "shelves";          // A = pages, C = shelves (§6)
  reduceMotion: "system" | "on" | "off";
  nsfw: { hotkey: string; whenHidden: "stub" | "invisible"; autoRehide: boolean; pinHash?: string };
}
```

Active state is **not** stored. It is always derived from disk: a skin is active when its folders are in Mods and not `DISABLED`-prefixed. Pending picks live in memory until Apply.

**Libraries are not skins.** Global helper mods are always on and are never shown in the grid. They're listed read-only under Settings › Libraries: `ORFix.ini`, `ORFixAPI.ini`, `BufferValues/HealthBar.ini`, `TexFx-main/`.
Detect them in two steps:
1. A known-names list: `ORFix*`, `ORFixAPI*`, `BufferValues/`, `HealthBar*`, `TexFx*`, `RabbitFX*`.
2. A heuristic: the ini declares a `namespace`, and none of its `[TextureOverride*]` hashes match an entity in the hash index (§5).

Don't rely on `namespace = global\...` alone. On this machine `ORFixAPI.ini` uses `namespace = GIMI`, the TexFx inis use
`namespace = TexFx`, and `ORFix.ini` does contain 5 `[TextureOverride*]` sections (plus ~300 `[ShaderOverride*]`).
Heuristic matches appear in the import review as "Looks like a library" so the user can confirm.

## 5. First run, import and the real environment

### Real paths on this machine
- Current loader: standalone GIMI/3DMigoto at `D:\mods\3dmigoto` (exe `3DMigoto Loader.exe`, Mods at `D:\mods\3dmigoto\Mods`). It targets `D:\Games\hoyoverse\Genshin Impact game\GenshinImpact.exe`.
- XXMI is **not installed yet**. The user will install it; its default Mods path is `%AppData%\XXMI Launcher\GIMI\Mods`. Pre-fill it if it exists.
- Standalone GIMI is deprecated upstream (the GIMI README points to XXMI), which is why XXMI support matters. Both use the same 3DMigoto ini rules.
- Unextracted archive library: `D:\mods\3dmigoto\Mods\Charecters and wepon\<Character>\*.zip|*.rar` (the folder names keep the user's spelling). It sits **inside Mods**. That's harmless (3DMigoto only loads `.ini` files), but after import move it to `<Library>/archives/<Entity>/` so `sourceArchive` stays re-extractable and Mods stays clean. The user agreed to this; show it as a pre-checked option in the review.
- Currently installed in Mods: `paimon_cc116/Paimon/`, `sandrone_marionette_by_neyori/` (with `Face/`, `outfit/`, `A Teaspoon of Transcendence/`), plus the libraries above. There are also stray `paimon_cc116.zip` and `sandrone_marionette_by_neyori.zip` in the Mods root; offer to move them to the Library.
- `A Teaspoon of Transcendence/` is Sandrone's weapon (the user confirmed). It overrides a single texture with an `alt 9` colour cycle. Import it as a separate **weapon** skin of the weapon *A Teaspoon of Transcendence*. It's a sibling folder, so splitting it needs no file moves.
- `Mods/.impeccable/hook.cache.json` is a stray cache from a dev tool. It's harmless. The scanner skips dot-folders.
- `paimon_cc116` is Paimon, which is an NPC in the hash index. Default category: character.

### First-run flow
1. Ask for the loader and Mods folder (pre-fill the paths above) and a Library path (suggest `D:\mods\SkinLibrary`, on the same drive as Mods).
2. Scan `Mods/` recursively for mod roots, then group them into skins (rules below). Skip libraries, `DISABLED*` (case-insensitive), dot-folders and `desktop.ini`.
3. **Also import the archive library** (the user wants this). Extract each archive in `Charecters and wepon` (§9) and treat each as a skin of its parent folder's character.
4. Guess each skin's entity, in this order: (a) its `[TextureOverride*]` hashes looked up in the hash index, (b) hashes of skins the user already confirmed, (c) a fuzzy match of the parent folder, archive and ini names against entity names and aliases. Show a review list ("Furina › Remembrance", "Alyosha › Frostbound Hunt") with the guess and how sure it is. The user can fix the entity, skin name and NSFW flag, or split extras out. Nothing is moved until the user confirms.
5. If two or more skins of one entity end up enabled, ask which one to keep active. All imported archives start inactive.
6. "Re-scan" in Settings runs the same review for new, unknown folders.

### Mod roots and grouping
- A **loadable ini** is any `.ini` that 3DMigoto would load: not under a `DISABLED*` name, not `desktop.ini`, not a library. It contains at least one `[TextureOverride*]` with a `hash`.
- Inis nest freely. Sandrone's `Face/` holds four of them (`Face/Eyes/Face.ini`, `Face/Face/Eyes/SandroneEyes.ini`, `Face/Face Texture/Sandrone.ini`, `Face/Mouth/Face.ini`), and `Face/` itself holds none.
- Collapse upward: a skin's folder is the highest ancestor (below Mods, or below an entity container such as `Mods/Furina/`) that contains no other skin's inis. Sandrone's four face inis collapse to `Face/`. Together with `outfit/` they make one skin with `folders: [sandrone_marionette_by_neyori/Face, sandrone_marionette_by_neyori/outfit]`.
- Parts or alternatives? Two roots of the same entity that override **mostly different** hashes (face vs. outfit) are parts of one skin. Two roots that override the **same main hashes** (the body `ib`/`position_vb`) are alternative skins, e.g. two folders under `Mods/Furina/`. Roots of a **different** entity (a weapon, Oz) are separate skins. The review screen lets the user correct the grouping.
- A `merged.ini` next to `DISABLED*` variant folders (Charlotte, Kazuha, Devine Astrologist Mona, Sakura Kimono Yae, Varesa lewd) is one skin rooted at the folder holding `merged.ini`. Never touch the inner `DISABLED*` names.

### Hash index (entity detection)
- `SilentNightSound/GI-Model-Importer-Assets` (the `Data` submodule of the GIMI repo, last updated 2026-08) has a `hash.json` for 135 characters, 209 weapons, 46 NPCs (Paimon included), plus enemies and misc. Each lists components with `ib`, `position_vb`, `blend_vb`, `texcoord_vb`, `draw_vb` and texture hashes.
- Verified against this disk: the installed Sandrone mod overrides `65a4831f` = Sandrone `position_vb`, and Paimon's mod overrides `1f7f0600` = Paimon `position_vb`.
- Build step: `scripts/build-hash-index` reads every `hash.json` and writes `src-tauri/resources/hash_index.json` (hash → entity name, category, component). Map `PlayerCharacterData` → character, `WeaponData` → weapon, everything else → user picks (default character). Bundle the file into the app so detection works offline.
- **Licence:** GI-Model-Importer-Assets is GPL-3.0, and this repo is public with no licence. So **don't commit** `hash_index.json`: gitignore it and have the script fetch and generate it (an npm `prebuild`/`predev` step that skips if the file is fresh). Credit the source in the README. Fixture inis may quote a handful of real hashes.
- Settings › Library gets an optional "Update hash index" button that fetches the latest data.
- Game patches change some hashes. Mods often carry old and new hashes, and anything unmatched falls back to learned hashes and then name matching.

### Archive facts to handle (verified by listing their contents)
| Archive | Gotcha |
|---|---|
| `Charlotte/bearcharlotte.zip`, `Furina/casualfurina.zip` | Bundle their own `BufferValues/ORFix.ini`. **Skip** it, because a global ORFix already exists and duplicates conflict. Generally, skip bundled copies of known libraries. |
| `Neuvilette/neuvilletteweddingrelease.zip` | A single wrapper `NeuvilletteWedding/` holding two sibling roots. `TomeOfTheEternalFlowGoldRecolor/` becomes a separate skin of the weapon *Tome of the Eternal Flow*. `www.patreon.com annplan.png` is a promo image: allowed as a preview, but never the default cover. |
| `Benny/bennettbeachday.zip` | `TravelerHandySword/SkywardBlade.ini` is a weapon skin (Skyward Blade), but it sits **inside** the `BennettBeachDay/` root (which holds `BennettAdventure.ini`), so it can't be toggled on its own where it is. On import, move it out to its own skin folder (`Mods/Skyward Blade/Bennett Beach Day/`). `Face/` is part of the Bennett skin. The folder name "Benny" means Bennett. |
| `Fischl/fischlhexenzirkel.zip` | `OzMod/Oz.ini` is an extra *Oz* (parent: Fischl). It is nested inside the `FischlHexenzirkel/` root, so move it out on import, like Bennett's sword. |
| `Benny/…`, `Furina/furinaremembrance-kaichume_61_0ae84.zip` | Contain `desktop.ini` (a Windows Explorer file). 3DMigoto would parse it as a mod ini, so never extract `desktop.ini`, `Thumbs.db`, `.DS_Store` or `__MACOSX/`. |
| `Veresa/sfw/varesa_by_neyori_e0d4f.zip` | Two roots (`Face/…`, `Outfit/…`) at archive top level form **one** skin with `folders: [..]`. Also contains `.hlsl` shader files next to the inis; keep everything. |
| `Veresa/nsfw/weebovz_-_cow_girl_og_varesa_toggle.rar` | Files (`Varesa.ini`, `help.ini`, `help.txt`) at the archive root, with no wrapper folder. Create a folder from the archive name. 115 MB, so show progress. |
| `Veresa/nsfw/varesa_lewd_-_culott_e_mort_1828d.zip` | `merged.ini` plus many `DISABLED…` variant subfolders. Keep as one skin and don't touch the inner DISABLED folders. The folder name is `Culottée à mort`: Linux bsdtar decodes it fine, but Windows `tar.exe` may garble it (`Culott�e � mort`) depending on the code page. Sanitise names on extract. |
| `Veresa/nsfw/varesanudemodrenkamui.zip` | A single wrapper `VaresaNudeModRenKamui/`. nsfw=true. |
| `Kazuha/kazuha_multi_v10.zip` | Has `Instructions.txt` and a `resource/menu/*.png` UI. Don't use the menu PNGs as previews (exclude paths containing `menu`, `cursor`, `btn`, `res/swp`). `resource/black_red/KazuhaPonyHeadDiffuse.png` is a **texture**, not a preview (§10). `Toukabou/DISABLEDtoukabou.ini` is a disabled sub-mod; leave it alone. |
| `Diluc/dilucinwhitebetterhair.rar` | Contains `prev (1..6).png`, which are real previews. Use them. |
| `Alyosha/…zip` | The ini is spelled `Aloysha.ini`. Match entities fuzzily. |
| `Tome_of_Eternal/tome_of_eternal_blood_flow.rar` | A weapon skin (*Tome of the Eternal Flow*), not a character. |

Formats: 19 `.zip` and 4 `.rar` (all RAR5; libarchive lists all of them and extracted two in a test with bsdtar 3.8.10). There are **no `.7z`** archives in the
library. The earlier spec listed a `Veresa/nsfw/varesa_sfw.7z`, but no such file exists (checked 2026-10-19).

**NSFW defaults:** only Varesa has NSFW skins. `varesa_lewd…`, `varesanudemodrenkamui…` and `weebovz…cow_girl…` default to nsfw=true. Everything else, including `varesa_by_neyori`, defaults to false. The user confirms in the review.

## 6. Layout modes (A = "Pages", C = "Shelves"). Switch in Settings › Appearance

Both modes share the toolbar, the pending bar, toasts, Settings, the A3 skin detail page and the A4 Add dialog. Switching modes keeps context (same entity focused or open) and animates (§7).

**Global toolbar** (all main screens): search box, category filter chips (All · Characters · Weapons · Extras · Modded only), the NSFW indicator chip, "+ Add", "Settings".

**Global pending bar** (bottom, only when there are pending changes):
`2 PENDING · Arlecchino: Elegant → Magical · Neuvillette: Wedding → Vampire   [Discard] [Apply]`.
After Apply, a toast: **"Applied. Press F10 in game to reload."** (about 6s, bottom-right). For the same 6s the window title also reads "Applied — press F10", so it shows in the taskbar while the game is focused.

### Mode C — Shelves (default)
- **C1 Home:** one scrolling page with sections (Characters · 16, Weapons · 3, Extras · 1), each with a header. 6-column grid of compact cards (4 columns at 1000px). Each card has a round portrait, the name, the active skin name, and a row of dots (one per skin, filled = active; NSFW skins aren't counted while hidden). Badges: "PENDING" (yellow) and "!" (conflict). Right-click a card for a quick-switch context menu (skins as radio items).
- Click a card to open its **C2 shelf**. Click again or press Esc to close. Only one shelf is open at a time.
- **C2 Shelf:** opens under the clicked card's row at full width and pushes the rows below down. The card gets an attached "tab" look.
  - Header: entity name · hint ("click a skin to make it active · double-click for details") · "Open folder" · "Open full page" (goes to A2) · close ×. The open card's name gets a "▴".
  - A horizontal strip of skin cards: **Original / no mod** first, then each skin (cover, radio dot, name, author, "⋯"), then a dashed **"+ Drop archive"** card.
  - Clicking a skin card makes it the pending active skin. Radio behaviour covers the whole entity, including Original.
  - When NSFW is hidden, a small dashed **"+3 · CTRL+H"** stub shows instead. Revealing expands the NSFW cards into the strip with an "18+" tag.
  - The "⋯" menu has: Edit details · Open folder · Open GameBanana · Remove… (to Recycle Bin, with confirm).
- **C3 Quick peek:** press `I` or the ⓘ button on a shelf card. The shelf grows into 3 columns:
  - left: the skin list (still clickable)
  - middle: gallery (main image + thumbnail strip with a "+ drop" tile)
  - right: name + ACTIVE tag, author and links, hotkey table, conflict warning, notes, and "▴ Less"
  
  Below about 1100px, open A3 instead.
- **C4 Drop on card:** while an archive is dragged over the window, every entity card becomes a drop target, and two tiles appear: "+ New character" and "+ New weapon / extra". The hovered card gets a dashed outline, and a small chip with the archive's file name (`Mona_[skin].zip ⤓`) follows the cursor. Dropping on a card opens a popover anchored to it: "Add to Mona", archive summary ("1 mod · 2 images"), Skin name, GameBanana link, NSFW toggle, preview source (GameBanana · Archive (n) · Own image · Later), Cancel / **Add**. Dropping on "+ New character" opens the same popover, which also asks for a name and a portrait (drop an image on the circle). After adding, that entity's shelf opens with the new skin. Dropping anywhere else opens A4.

### Mode A — Pages
- **A1 Home:** the same sectioned grid, but with larger portrait cards (5 columns, 4 at 1000px). Each shows the active skin's cover as a backdrop and the dots and badges. Click a card to go to **A2**. There are no shelves.
- **A2 Character page:** header with "← All characters", portrait, name, "1 of 4 skins shown · 3 hidden (18+) · Mods/Varesa/", NSFW chip, "+ Add skin to <name>", and "⋯". Below it, a 5-column grid (4 at 1000px) of large skin cards:
  - the Original card ("Original / no mod", subtitle "Disables every Varesa skin")
  - skin cards (radio + ACTIVE tag, "by [author] · 3 images · 2 hotkeys", ⋯ menu)
  - a dashed "Drop archive here" card
  
  When NSFW is hidden, show one placeholder card "3 skins hidden · Press Ctrl+H to reveal", or nothing if set to invisible. Esc/Backspace goes back home.
- Dropping an archive anywhere in Mode A opens A4. On A2, A4 is pre-filled with that character.

### Shared pages
- **A3 Skin detail** (both modes; double-click a skin card): breadcrumb "All characters › Kazuha › Multi", "← Kazuha", and Prev/Next skin buttons.
  - Left (about 640px): big preview + 6 thumbnails (the last tile is "+ drop / paste") and a caption with image sources ("3 from GameBanana · 2 from archive"). Drag to reorder; the first image is the cover. ←/→ steps through images.
  - Right: name + ACTIVE tag; author, version, added date, folder(s); "Set active" / "Set as Original (turn off)", "Open folder", "GameBanana page ↗"; hotkey table (keycaps, label, kind; labels editable inline and saved in library.json, never written to the mod); conflict warning ("Key 6 is also used by Furina · Remembrance (active). Both toggle at once in game."); notes textarea (autosave).
- **A4 Add skin dialog** (modal):
  - Left: archive summary (name, size, counts, "Choose another…") and a tree of its contents. If the archive holds several mod roots, show a checkbox list with grouping: roots in one skin vs. split into separate entities (§5 extras).
  - Right: Character (auto-guessed, dropdown) · "+ New character…" (sub-dialog: name, category, drop a portrait) · Skin name · GameBanana link (pasting fills name/author and fetches previews) · NSFW toggle · Preview source · "Make it the active skin after adding".
  - Footer: "Extracts & files it under <Character> / <Skin>" · Cancel · **Extract & add**. Extraction runs in the background with progress.
- **Settings** (full page, "← Back" returns exactly to the previous screen, and changes save instantly):
  - **Appearance:** layout mode Pages / Shelves (a live preview thumbnail of each) and Reduce motion (System / On / Off).
  - **Mod loader:** XXMI / 3DMigoto radio, each with its own Mods path + Browse. Switching re-scans.
  - **Library:** path + Browse; disable method (Move to Library stash / DISABLED prefix); Re-scan now; Open Mods folder; read-only list of Libraries (§4); "Update hash index" with the snapshot date (§5).
  - **NSFW:** reveal hotkey (click-to-record, default Ctrl+H); when hidden: small stub vs. fully invisible; auto re-hide on minimize or after 5 minutes idle.
  - **PIN lock:** toggle + 4–6 digit PIN, stored as a salted hash (argon2 or sha256+salt). This is a soft lock, not encryption.

### Empty states
- Entity with no skins (e.g. Ganyu): the card says "Original · no skins yet". The shelf or A2 shows only Original plus a large "No skins yet — drop a .zip / .rar / .7z here or click to browse".
- No Mods folder set: the full-screen first-run setup (§5).

## 7. Motion design (top requirement: nothing should snap)

Every navigation and state change animates. The feel is smooth and physical, never slow.

**Tokens** (one file, e.g. `src/motion.ts`):
- Springs: `snappy` (stiffness 500, damping 38) for small UI; `smooth` (stiffness 260, damping 30) for layout and shelves; `gentle` (stiffness 170, damping 26) for page-level moves.
- Durations: micro 120ms, small 200ms, medium 320ms, page 450ms max. Ease out: `[0.22, 1, 0.36, 1]`.
- Stagger: 25–35ms per item, capped so a full grid finishes in at most 400ms.

**Required transitions:**
| Moment | Animation |
|---|---|
| App launch | Toolbar fades down, then grid cards stagger in (fade + 8px rise + scale 0.98→1) |
| Home ↔ A2 character page | **Shared element**: the card's portrait/cover morphs into the A2 header portrait (`layoutId`); other cards fade and scale back slightly; the A2 skin grid staggers in. Reverse on back. |
| Skin card → A3 detail | Shared element: the card cover morphs into the big preview; the right panel slides in from 24px right with a fade |
| Prev/Next skin in A3, image ←/→ | Direction-aware slide + crossfade |
| C2 shelf open/close | Height springs open (`smooth`); rows below glide down via `layout`; skin cards stagger in from left; the attached "tab" on the card grows in. Opening another shelf closes the old one at the same time with no jump. |
| C3 quick peek | The shelf height and its 3 columns morph with `layout`; the gallery fades in |
| Selecting a skin | The radio dot fills with a spring pop; the **ACTIVE / PENDING tag slides between cards** (shared `layoutId`); the old card de-emphasises smoothly; the entity card's subtitle crossfades to the new name |
| Pending bar | Slides up from the bottom with a spring; the count ticks (animated number); a new diff item enters with a slide; Discard collapses items out |
| Apply | Button morphs into a progress state → check mark; PENDING badges dissolve; toast springs in from the bottom-right and auto-dismisses with a fade |
| Modals (A4, confirm, PIN) | Backdrop fades + blurs in; dialog scales 0.96→1 + fades; exit reverses (AnimatePresence) |
| Popovers (C4, ⋯ menus, context menu) | Scale from the anchor origin (transform-origin at the trigger) + fade |
| Drag archive over window | Cards get a dashed glowing outline that pulses softly; the hovered target lifts (scale 1.03 + shadow); the extra "+ New" tiles slide in |
| Search / filter chips | Filtered cards animate out (fade + scale) and the rest reflow with `layout`; section headers update counts with a number tween |
| NSFW reveal | Hidden cards stagger in with blur(8px)→0 + fade; hide reverses quickly (150ms) |
| Layout mode switch (Settings) | Crossfade + slight scale of the whole main area; persist and restore scroll |
| Hover / press | Cards lift 2px with a shadow (micro); press scales to 0.98 |
| Loading states | Skeleton shimmer for preview fetching; spinners only inside buttons |
| Toasts / errors | Slide + fade; error toasts shake once (small, 4px) |

**Rules:**
- Animate only `transform` and `opacity` (and `filter` sparingly) for 60fps. Use `LayoutGroup` and `layoutId` for the shared elements.
- Respect `prefers-reduced-motion` plus the Settings override. Reduced = crossfades only, no movement and no stagger.
- Animations must never block input. Interrupting one (e.g. clicking another card mid-animation) retargets smoothly.
- Lazy-load and decode cover images (`decoding="async"`, with a size-limited thumbnail cache from the Rust side) so morphs don't stutter on large DDS-derived PNGs.

## 8. Hotkey parsing & conflicts

- Parse every **loadable** `.ini` in a skin's folders (skip `DISABLED*` names, so a merged pack's inner variants don't count). For each section named `[Key...]`, read `key`, `back`, `type` and `condition`. The label defaults to the section name minus `Key` (`[KeyHat]` → "Hat").
- **Key syntax** (from the d3dx.ini docs): a key is one virtual key plus modifier rules, separated by spaces and case-insensitive. A–Z and 0–9 are single characters; anything else is a VK name with or without `VK_` (`VK_F1` = `F1`), or a hex code. `ctrl` / `alt` / `shift` / `windows` must be held. `no_ctrl` / `no_alt` / `no_shift` / `no_windows` must not be held. `no_modifiers` means none of the four may be held. **A modifier that isn't mentioned is "don't care"**, so a plain `8` also fires on Alt+8. Parse each key into `{vk, required, forbidden}`. Show it as keycaps (`Alt + 8`) with a small "only without modifiers" hint where relevant. Keep XInput (`XB_*`) and mouse keys, but don't check them for conflicts.
- **Overlap:** two keys overlap when some real key press fires both: same `vk`, and neither one requires a modifier the other forbids. `8` overlaps `alt 8` and `no_modifiers 8`; `no_modifiers 8` does not overlap `alt 8`.
- **Severity:** most character mods gate their keys with `condition = $active == 1` (`$active` is set while that model is being drawn), so two gated keys only clash when both models are on screen together.
  - **Conflict** (red "!" badge on both entity cards): either key has no `condition`, or the two entities appear together (a weapon with any character; an extra with its parent).
  - **Overlap note** (muted text, no badge): both keys are gated and the entities are different characters. These only matter when both are on screen, e.g. Paimon in a dialogue scene, or co-op.
- Show conflicts as a warning row in the skin detail: "Key 6 is also used by Furina · Remembrance (active)" (clickable). Compute against the **pending** state, so conflicts show before Apply.
- Real examples (verified in the installed inis):
  - Sandrone (Neyori) `outfit/Sandrone.ini`: `no_modifiers 6` Body, `no_modifiers 7` Hand, `no_modifiers 8` Hat, `no_modifiers 9` Dress, `alt 8` Color. `Face/Face Texture/Sandrone.ini`: `alt 7` Swap. Weapon folder `A Teaspoon of Transcendence`: `alt 9` Color. All gated.
  - Paimon: `0` Halo, `8` Wings, `9` Legs, all `condition = $active == 1`. Paimon's `8` overlaps Sandrone's `no_modifiers 8` **and** `alt 8`, and `9` overlaps `no_modifiers 9`. All of them are gated, so this is an overlap note, not a red conflict. Paimon's `9` also overlaps the weapon's `alt 9`, and by the rule above weapon + character is a red conflict.

## 9. Archive extraction

- Use the Windows built-in **`C:\Windows\System32\tar.exe`** (bsdtar/libarchive 3.8.8). It's verified to list .zip, .rar and .7z here. No bundling is needed.
- On Linux (dev/test only, §0), call `bsdtar` from PATH. Plain `tar` there is GNU tar, which can't read .zip or .rar.
- Fallbacks if tar fails on an archive: 7-Zip (`7z.exe`) if installed, then WinRAR's `C:\Program Files\WinRAR\UnRAR.exe` (installed) for .rar.
- Extract to a temp dir under the Library first, sanitise names, then move into place. Strip a single wrapper folder only when it's the only top-level item.
- List contents (`tar -tf`) before extracting to fill the A4 tree.
- **Archives are untrusted.** Reject the whole archive if any entry has an absolute path, a drive letter, a `..` component or a symlink. After extracting, check that every file resolves inside the temp dir.
- Skip junk entries: `desktop.ini`, `Thumbs.db`, `.DS_Store`, `__MACOSX/`.
- Never place bundled copies of known libraries (e.g. `BufferValues/ORFix.ini`) into Mods. Leave them out of the skin entirely.
- Sanitise names for Windows: strip characters invalid on NTFS (`<>:"/\|?*` and control characters), trailing dots and spaces, and reserved names (`CON`, `NUL`, `COM1`…). Keep valid Unicode as it is.

## 10. Previews

Four states every skin card renders:
1. **Fetching from GameBanana…** (skeleton shimmer) after a link is pasted.
2. **Found in archive**: png/jpg/webp inside the archive are copied to previews, minus UI assets (§5) and minus **textures**. Mods use .png/.jpg as textures too (`PaimonBodyShadowRamp.jpg`, `KazuhaPonyHeadDiffuse.png`). Exclude any image that an ini references via `filename =`, and any image whose name contains `Diffuse`, `LightMap`, `NormalMap`, `ShadowRamp`, `MetalMap` or `Mask`. Sort names containing `prev`, `preview`, `showcase`, `cover` or `screenshot` first.
3. **Drop or paste**: drag an image onto any card or the gallery, or press Ctrl+V while it's focused.
4. **Empty**: a dashed box "+ Add preview".

GameBanana: parse the mod id from the URL (`gamebanana.com/mods/<id>`), fetch `https://gamebanana.com/apiv11/Mod/<id>/ProfilePage`, and read `_sName`, `_aSubmitter._sName` and the `_aPreviewMedia._aImages[]` (`_sBaseUrl` + `/` + `_sFile`). **Verify the shape live while building.** Download into `<Library>/previews/<skinId>/` from the Rust side (no CORS issues). On failure, fall back quietly to state 4 with a "Retry" link. Serve local images through Tauri's asset protocol (`convertFileSrc`) with the scope limited to the Library.

## 11. NSFW behaviour ("hidden by default")

- NSFW skins are hidden everywhere by default: grid dots, counts, shelves, search results.
- Ctrl+H (configurable) toggles visibility globally. If a PIN is set, ask for it on reveal.
- The toolbar chip reads "18+ HIDDEN · CTRL+H" / "18+ VISIBLE · CTRL+H TO HIDE". Keep it small and neutral.
- If an entity's *active* skin is NSFW while hidden, its card shows "Modded (hidden)" with a generic placeholder cover.
- Auto re-hide on minimize or idle, per Settings.

## 12. Keyboard shortcuts

| Key | Action |
|---|---|
| Ctrl+F or just type | focus search |
| Arrow keys | move focus across cards / skins |
| Enter | Shelves: open shelf, then again opens A2 · Pages: open A2 |
| Space | pick focused skin |
| I | quick peek (Shelves) / open A3 (Pages) |
| Esc / Backspace | close shelf / go back |
| Ctrl+S | Apply |
| Ctrl+Z | undo the last pending change |
| Ctrl+H | toggle NSFW visibility |

All shortcuts work only while the app window is focused. There's no global system hook.

## 13. Tauri implementation notes

- **File drops:** Tauri intercepts OS file drops, so DOM `drop` events don't fire with paths. Use `getCurrentWebview().onDragDropEvent` (enter/over/drop/leave give `paths` and `position`), then `document.elementFromPoint(position)` (adjusted for devicePixelRatio) to find the card under the cursor for C4 targeting and hover highlighting.
- **Clipboard image paste:** handle the DOM `paste` event and send the bytes to Rust to save.
- **Rust commands** (suggested): `scan`, `get_library`, `save_library`, `apply(plan)`, `list_archive`, `extract_archive` (emits progress events), `fetch_gamebanana`, `import_image`, `open_in_explorer`, `trash_path`, `parse_hotkeys`.
- Plugins: `dialog` (folder pickers), `opener`/`shell` (open folder or URL), `fs` scoped to the Mods and Library paths.
- Run all disk work in Rust, never in the webview.
- Layout: Tauri-free core logic in `src-tauri/src/core/` (unit-tested with `cargo test`, runs on Linux too); thin `#[tauri::command]` wrappers in `src-tauri/src/commands.rs`. Frontend calls go through one typed `src/api/` interface, so components never call `invoke` directly. It has two implementations: `tauri.ts` (real) and `mock.ts` (test harness, §0).
- Bundle `resources/hash_index.json` (§5) via `bundle.resources`.

## 14. Fixtures / testing

Build `D:\mods\skin-switcher\fixtures\Mods\` (outside any real Mods folder) with the §5 roster as tiny dummy `.ini` files, each containing a `[TextureOverride…]` and a couple of `[Key…]` sections. Use **real hashes from the hash index** so entity detection gets tested. Include:
- an overlap note: gated key 6 on Kazuha · Multi and on Furina · Remembrance
- a red conflict: an ungated key, or a weapon skin sharing a key with a character
- one multi-root skin (Varesa by Neyori), and one nested-ini skin (like Sandrone's `Face/`) that must collapse to one folder
- one merged pack (`merged.ini` + `DISABLED*` variant folders)
- library inis: one `namespace = global\…`, one `namespace = GIMI` (like ORFixAPI), and one with `[TextureOverride*]` (like ORFix)
- `DISABLED_` folders and files in mixed case (`disabled_x/`, `DISABLEDVaresa.ini`)
- a `desktop.ini`, a `.dotfolder/` and stray `.zip` files in the Mods root
- a fixture `d3dx_user.ini` next to `fixtures\Mods\` for the persist backup/restore tests
- sample archives in `fixtures\archives\`: one .zip, one .rar and one .7z (no real .7z exists, so make one with `bsdtar --format 7zip -cf` or 7-Zip); one with a nested weapon folder (like Bennett's); one with files at the root and no wrapper folder; and one **malicious** archive (a `../` entry) that must be rejected. Making a .rar needs WinRAR on Windows; check the result into git.

Rust unit tests cover the scanner and grouping, entity detection, the hotkey parser and overlap rules, Apply with forced mid-batch failure → rollback, journal recovery, persist backup/restore, the method migration, and archive path checks.

## 15. Build order (milestones)

0. Prerequisites (§0). Scaffold Tauri 2 + React + TS + Vite. Add Motion, Zustand and the design tokens + motion tokens (§2, §7), the **animated page/router shell** (AnimatePresence + LayoutGroup) so every screen is built on it from day one, and the typed `src/api/` interface with the mock test backend.
1. Settings page (Appearance, loader, library paths) + persistence.
2. Hash index build script + bundled `hash_index.json`. Rust scanner (mod roots, grouping, active/inactive, libraries, entity detection), library.json read/write, fixtures.
3. Mode C: C1 grid + C2 shelf + pending bar + Apply (batched with rollback, journal, persist backup/restore) + toast. **← usable MVP**
4. Mode A: A1 + A2. Shared A3 detail, C3 quick peek, the layout switch, hotkey parsing + conflicts.
5. Add flow: drag-drop detection, tar extraction, A4 dialog, C4 popover, new-character sub-dialog.
6. First-run import of the real Mods folder + archive library, with the review screen (§5).
7. Previews: archive images, drop/paste, GameBanana fetch.
8. NSFW hide/reveal, PIN, auto re-hide. Keyboard shortcuts. 1000×700 layout pass. Motion polish pass (check every row of the §7 table).
9. Package with the Tauri bundler (NSIS installer).

## 16. Acceptance checks

- Picking a skin then pressing Apply leaves exactly one enabled copy of that entity's skins in Mods.
- An Apply that fails mid-way rolls everything back; the disk state matches what it was before.
- In move mode, a skin's relative path in Mods is identical every time it's activated.
- Conflicts show before Apply and disappear once resolved.
- With NSFW hidden, nothing NSFW (names, covers, counts) is visible anywhere, including search.
- Removing a skin puts its folder in the Recycle Bin.
- Both layout modes work at 1000×700 with no horizontal scrolling. Switching modes keeps context.
- Every row in the §7 table animates; nothing snaps. Reduced-motion mode removes movement but keeps crossfades.
- Bundled duplicate `ORFix.ini` copies are never placed into Mods.
- `desktop.ini` and other junk files from archives are never placed into Mods. An archive with a `../` or absolute-path entry is rejected and nothing is written.
- Killing the app in the middle of an Apply, then restarting it, restores the disk to its state before that Apply.
- With the game closed: set a toggle in game (e.g. Sandrone hat = 2), exit the game, switch to another skin and back, start the game. The toggle is still 2.
- The importer puts the installed Sandrone mod under Sandrone (by hash, not by name) and Paimon under Paimon.
