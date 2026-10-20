# Decisions

Judgement calls made during the unattended build. Newest last. SPEC.md stays the source of truth;
these fill gaps or record where something had to be interpreted.

## M0 Scaffold

- **Scaffold:** `create-tauri-app@4.7.5` (React + TS + Vite) generated in a scratch folder and copied in, keeping
  SPEC.md, CLAUDE.md, docs/ and .gitignore (ignore entries merged).
- **TypeScript stays on 6.0.x.** TS 7 is out, but `typescript-eslint` 8.71 only supports `<6.1`.
- **Mock backend selection** uses a Vite alias (`@api-impl` -> `src/api/tauri.ts` or `src/api/mock.ts`), not a runtime
  flag, so the mock is never even parsed into release bundles. `npm run build` runs `scripts/check-no-mock.mjs`
  afterwards and fails if `__mock` shows up in `dist/`. Mock builds go to `dist-mock/`.
- **Design context for the impeccable skill:** `docs/PRODUCT.md` and `docs/DESIGN.md` were derived from SPEC §1-2 and
  §7 (the user is away and asked for no questions; SPEC is user-authored, so it is a fair source).
- **SPEC beats the skill's product-register advice on launch motion.** The skill discourages page-load choreography
  for product UI; SPEC §7 explicitly requires the toolbar fade + card stagger on launch, so it ships.
- **Boot state shows nothing** (blank background) instead of a spinner: §7 says spinners only inside buttons.
- **No `fs` plugin.** SPEC §13 lists it, but it also says all disk work runs in Rust. The webview never touches the
  file system directly, so the plugin would only widen the attack surface. Images are served via the asset protocol.
- **Window:** 1280x800, min 1000x700, `backgroundColor` set to the app's `--bg` so there is no white flash.
- **PR screenshots** live on an orphan `pr-assets` branch (never merged). Only browser-harness captures with generated
  art go there, never real mod files, previews or names from the user's disk.

## M1 Settings

- **Settings file** lives in the OS app config dir (`%AppData%\com.signioratif.skinswitcher\settings.json` on
  Windows), written atomically with a `.bak`. `SKIN_SWITCHER_CONFIG_DIR` overrides it so e2e runs never touch real
  settings.
- **The Library may not sit inside a Mods folder** (or vice versa). 3DMigoto loads every `.ini` under Mods, so a
  Library there would load every stashed skin. Saving such settings is refused with a clear message.
- **Different drives** are allowed but flagged in Settings › Library (moves become copies, SPEC §3).
- **Path fields commit on blur or Enter**, not per keystroke, so typing a path doesn't trigger a re-scan per letter.
- **NSFW reveal hotkey must include Ctrl or Alt.** SPEC §12 makes plain typing focus search, so a bare letter would
  be swallowed.
- **Layout previews are live miniatures** built from the user's own portraits and covers (SPEC §6 "live preview
  thumbnail"), not static images.
- **PIN lock UI is deferred to M8** with the rest of the NSFW work; M1 ships the NSFW hotkey / when-hidden / auto
  re-hide settings.
- **The Rust side owns an `AppCore`** (Tauri-free) that every command calls into, so integration tests drive the same
  code paths as the app.
- **Asset protocol scope is `<Library>/previews` and `<Library>/portraits` only**, not the whole Library, so a
  badly chosen Library path can't expose a drive to the webview. The Library also may not be a drive root.
- **XXMI-only first run** suggests `%AppData%\XXMI Launcher\SkinLibrary` (same drive, user-writable, outside
  `GIMI\Mods`); otherwise `D:\mods\SkinLibrary` as SPEC §5 says.
- **Commands are async** and do their disk work on a blocking thread (Tauri runs sync commands on the main thread).

## M2 Hash index, scanner, fixtures

- **Two index builders.** `scripts/build-hash-index.mjs` (predev/prebuild) and the in-app "Update hash index"
  (`src-tauri/src/net.rs`) produce the same JSON. The app loads whichever of the bundled and updated files is newer.
  The Rust copy exists because the button must work in a release build without Node.
- **`KaedeharaKazuha` displays as "Kazuha"** (and a few similar overrides) to match SPEC/wireframe naming.
- **Grouping rules** (SPEC §5, refined against the real disk):
  - parts vs alternatives = hash overlap ratio `|A∩B| / min(|A|,|B|)` with alternatives at >= 0.5. The real Sandrone
    `Face Texture` ini shares `65a4831f` with `outfit/`, so "any shared position hash" would wrongly split them.
  - an entity container (`Mods/Furina/`) needs an exact or alias name match; `paimon_cc116` (Paimon + more) is a mod
    folder and collapses to itself.
  - texture-only roots with no known entity are guessed as weapons (the real Teaspoon ini only swaps a diffuse).
  - a root's own folder name beats a non-container ancestor's name, so `sandrone_marionette_by_neyori/A Teaspoon of
    Transcendence` becomes its own weapon instead of more Sandrone.
- **Heuristic libraries** (namespace, no index hash, no name match) are kept out of the skin list and reported as
  "looks like a library" for the import review.
- **First-run quick import (temporary):** an empty library adopts every mod root with suggested names. The import
  milestone replaces this with the SPEC §5 review screen; later scans already report new folders instead of adopting.
- **Fixtures are generated** by `scripts/make-fixtures.mjs` (committed together with its output). Tests copy them to a
  temp dir before touching anything.
- **Parts merge at the Mods root too.** An archive like `varesa_by_neyori` extracted straight into Mods leaves
  `Face/` and `Outfit/` side by side at the root; they are one skin. Two unrelated same-entity mods with disjoint
  hashes at the root would also merge; the import review lets the user split them.
- **Hash values parse like 3DMigoto's `%lx`:** optional `0x`, leading hex digits, anything after (a `;note`) ignored.
- **Known skin folders are always roots.** Once imported, a folder keeps its grouping on every re-scan even if a
  later library name would make it look like an entity container.
- **The committed test index** (`fixtures/hash_index.test.json`) holds only the 35 hashes the fixture inis already
  quote (SPEC §5 allows fixtures to quote a handful of real hashes); the full index is never committed.

## M3 Shelves, pending bar, Apply

- **Apply refuses when the disk changed outside the app.** It re-scans first; if anything differs from what the UI
  last saw, nothing moves, the UI gets the fresh state with a toast, and picks that still make sense are kept. The
  user presses Apply again on purpose.
- **The journal is deleted only after verification.** Each touched skin is re-located after the batch; a mismatch rolls
  everything back like any other failure.
- **Interrupted cross-drive copies** are recorded as "started"; recovery deletes the partial copy (the source is
  intact) and undoes finished moves newest first.
- **Persist restore failures are warnings**, not rollbacks: the skins are switched, the toast says toggles weren't
  restored (SPEC §3 calls this best effort).
- **Disable-method migration runs inside save_settings** as one journaled batch; if it fails, the setting isn't saved.
- **Removing a skin** trashes every place its folders exist (Mods, DISABLED_ copy, stash) plus its previews, then tidies
  empty parents under Mods. Tests inject a fake trash so nothing lands in the real Recycle Bin.
- **Two skins of one entity enabled** (found on disk) show a red "!" on the card and a note in the shelf; picking one
  and applying turns the others off.
- **e2e fault injection** (`SKIN_SWITCHER_FAULT=fail:N|crash:N`) exists only in debug builds.
- **e2e binary** is a `tauri build --debug --no-bundle` copied to `~/.cache/skin-switcher-e2e/` so `tauri dev`
  (which builds to the same path without embedded assets) can't overwrite it.
- **Debug profile keeps only line tables** (`[profile.dev]`): full debug info pushed the target dir past 11 GB on a
  nearly full dev disk.
- **Cross-drive moves are two-phase in the journal** (started -> copied -> done). Recovery deletes a partial copy
  only while the source is intact; once the copy is verified it rebuilds the source from it instead.
- **A leftover journal is always recovered first**; a new batch never overwrites it. A successful batch marks its
  journal committed before deleting it, so a failed delete can't cause a spurious rollback on the next start.
- **d3dx_user.ini is merged on raw bytes** (BOM, CRLF, UTF-16 and ANSI bytes in other lines survive). The first copy
  ever touched is kept as `d3dx_user.ini.skinswitcher-original`; `.bak` holds the state before the latest write.
- **Un-imported mods of a picked character** stay enabled (Apply only moves library skins); Apply warns about them
  and points to Re-scan.

## M4 Pages mode, detail, quick peek, conflicts

- **Shared-element morphs use an explicit FLIP helper** (`src/components/Flip.tsx`), not Motion's `layoutId`.
  Across an AnimatePresence page swap Motion measured the new element but never started a shared transition (the
  outgoing page doesn't re-render), so the source records its rect right before navigating and the target animates
  from it on mount. It is StrictMode-safe and skipped under reduced motion.
- **ACTIVE/PENDING tags slide with `layoutId` only within one view** (a shelf strip, the A2 grid, the C3 list); the
  detail page and the peek list crossfade theirs so a tag never flies across the screen.
- **Conflicts are computed in the UI** from `Hotkey.parsed` (parsed in Rust) against the pending state, so they show
  before Apply and clear as soon as the pick changes. While 18+ skins are hidden they leave no trace: they don't
  raise conflicts, don't count toward "2 skins are on", and A2 only mentions the hidden count in "stub" mode.
- **Gated keys clash only as a muted note.** Two `$active`-gated keys collide only while both models are on screen,
  so a pair that can't share a screen (a weapon with another weapon, or an unrelated extra) still shows the grey
  overlap note rather than staying silent; we can't know which models appear together.
- **Home keeps one scroll position per layout** and carries the open shelf / last opened page across a layout
  switch (shelf <-> focused card).
- **C3 below 1100px opens A3** (SPEC); the `I` key does the same for the focused skin card.
- **A3 edits** (name, author, version, link, NSFW, owning entity, hotkey labels, notes) write library.json only.
- **Moving a skin to another character needs it to be off first**: an enabled skin's folders sit in Mods under its
  current owner's grouping, so the move is refused with "skin_enabled" until it is set to Original and applied.
  A failed library save restores the in-memory library, so the UI never shows an edit that isn't on disk.
- **Pages that are leaving ignore keys.** The outgoing page stays mounted during its exit animation, so A2/A3 key
  handlers check that the route still points at them; otherwise one Escape went back twice.

## M5 Add flow

- **Archives are read with bsdtar** (`bsdtar` on Linux, `C:\Windows\System32\tar.exe` on Windows), with 7-Zip and
  then UnRAR as Windows-only fallbacks. A .rar fixture can't be made on Linux without the non-free `rar` tool, so .rar
  is covered by the Windows testing guide instead of a fixture.
- **Analysis extracts only the .ini files** into a staging folder under the Library to find mod roots, entities and
  preview candidates; it is deleted afterwards. Nothing touches Mods until "Extract & add".
- **Mod folders in one archive**: the first root is the main skin and can't be unticked. A nested root (Bennett's
  sword, Oz) or one detected as another entity defaults to "its own skin", named after the main skin
  ("Bennett Beach Day"); unticked roots are left out entirely.
- **New skins land inactive** (stash or DISABLED_, per the disable method) unless "Make it the active skin" is on.
  A4 defaults it on, matching the wireframe; C4 leaves it off and opens the entity's shelf so the user picks it there.
- **C4 asks only for what it must** (name, link, NSFW, preview source; plus name, category and portrait for "+ New").
  When the archive holds more than one mod, it says so and "More options…" opens A4 on the same archive.
- **File pickers are Rust commands**, so debug builds can answer them with `SKIN_SWITCHER_E2E_PICK_ARCHIVE` /
  `_IMAGE` (like the Apply fault hook); WebDriver can't drive native dialogs or OS file drags.
- **A portrait picked from outside the Library isn't previewed**: the asset protocol is scoped to the Library, so the
  circle shows a check mark and the file name until the image is copied in.
- **The drag chip sits exactly on the cursor.** A spring only made it trail the OS drag image, and it got stuck when
  a drag started and moved within one frame.
- **The "From GameBanana link" preview tile is shown but disabled** until M7 fetches images; the pasted link is saved
  with the skin either way.
- **A committed Apply tidies the stash folders its moves emptied** (only empty folders, so there is nothing to undo).
- **Disk work stays serialised behind one lock**, adds included: an add and an Apply must never interleave. The window
  stays responsive because commands run off the main thread; a panicked command no longer poisons the lock for good.
- **Untrusted archive limits**: refused before extraction when the listing can't be parsed, a component is a Windows
  device name or would be trimmed to `..`, or the archive unpacks to more than 8 GB or 50,000 entries. There is no
  free-space check; a full disk fails the extraction and the staging folder is removed.
- **Staging folders** (`<Library>/tmp/<tag>-<pid>-<time>-<n>`) are created with `create_dir`, which fails if the name
  exists, and `<Library>/tmp` is swept at startup.
- **Split skins keep the archive's NSFW flag**: hiding a weapon by mistake is better than showing one.
- **`check:windows-core`** type-checks `src-tauri/src/core` for `x86_64-pc-windows-gnu` from Linux. The whole app
  can't be checked that way (ring needs a MinGW C compiler), so `commands.rs` Windows paths wait for the Windows run.

## M6 First-run import

- **Nothing is adopted silently any more.** Up to M5 a rescan adopted every unknown mod root into the library. Now a
  configured, empty library with unknown roots or archives opens the import review (after Setup, at boot, and from
  Settings "Re-scan now"); later rescans only refresh which skins are active.
- **Installed mods are adopted where they are.** Nothing in Mods is moved or renamed unless the user picks one skin
  to keep for an entity that has several enabled; that runs as one journaled Apply after the import.
- **Installed mods are proposed one per scanner root**, the same grouping the scanner uses for Apply (Sandrone's
  Teaspoon folder is its own root, so it becomes Teaspoon's skin). Archive roots get the add flow's split rules.
- **Each archive in the archive library is one add**: main root plus splits, using the add flow's extraction, junk
  and ORFix filtering, and undo. Skins from archives arrive inactive, in the stash.
- **The main root of an archive** is the one whose detected entity matches the archive's folder name
  (`Charecters and wepon/Fischl/…` → Fischl), else the first. Splits default to "`<entity> <skin>`".
- **Archives move to `<Library>/archives/<Entity>/`** after a successful import (default on), loose archives found
  directly in Mods to `<Library>/archives/` (default on). `source_archive` is updated to the new path. Folders
  emptied by the move are removed; folders holding anything else (`desktop.ini`) are left alone.
- **Unreadable archives are listed, not fatal**: the review says which ones can't be imported and why.
- **The plan is kept in the core between `plan_import` and `apply_import`**, and every choice is checked against it,
  so the frontend can't make the importer touch a path it didn't propose.
- **18+ in the review**: NSFW guesses (folder or file names) start hidden behind the global 18+ toggle; hidden rows
  show "Hidden 18+ skin" and a vague source. Split skins inherit the archive's flag.
- **Rows animate between groups** with shared layout ids; the moving row rides above the others so it never slides
  under a group heading.
- **One shared hash loses to the mod's own name.** The read-only dry run on the real Mods folder found a Bennett skin
  for a newer model whose only index hit was an eye override shared with another character. When the hash winner
  rests on a single matching hash and the root's own folder or ini name fully names a different entity (≥ 0.75),
  the name wins; two or more hits still beat any name.
- **Dry run result** (`examples/import_dry_run.rs`, Library = `~/.cache/skin-switcher-testlib`, Mods tree and
  `d3dx_user.ini` byte-identical before and after): Sandrone by hash, Paimon by hash, A Teaspoon of Transcendence as
  a weapon from the Sandrone folder, Bennett's Skyward Blade split out as a weapon skin, Oz split out under Fischl,
  Tome of the Eternal Flow as a weapon, bundled ORFix copies and desktop.ini skipped; every archive read.

## M8 NSFW, PIN and shortcuts

- **Backend and pure logic only for now.** The frontend is being redesigned, so the PIN dialog, the Settings PIN
  section, Ctrl+H and auto re-hide wiring and the reveal animation wait for it. The API, mock and helpers are ready.
- **The PIN is an Argon2id hash** (argon2 0.5 defaults, random salt from the OS) kept in `settings.json` as
  `nsfw.pinHash`. It is a soft lock, not encryption: deleting `pinHash` from the file removes the PIN, and that is
  also the way back from a forgotten one. A stored hash that can't be parsed never matches.
- **The hash never leaves the backend.** The snapshot drops it and says `pinSet` instead. `save_settings` keeps the
  stored hash whatever the UI sends; only `set_pin` changes it, and changing or removing a PIN needs the current one.
- **Wrong PINs are throttled**: 5 free tries, then a 30 s lockout that doubles with each further miss, up to 10 min.
  It counts `set_pin` guesses too and lives in memory, so restarting the app resets it.
- **argon2 and blake2 build at opt-level 3 in dev and test**, or one PIN check would take seconds there.
- **Minimize is detected in Rust** (`on_window_event`: a resize while minimized) and sent as a `window-minimized`
  event, so the webview needs no extra window permission. The mock treats a hidden browser tab as a minimize.
  Idle re-hide is a frontend timer (`IDLE_MS`, 5 min), since input events only exist in the webview.
- **NSFW visibility is not persisted**: every launch starts hidden (SPEC §11). Counts, search, conflicts and the
  pending bar already leave hidden skins out (`derive.ts`, `conflicts.ts`); Rust only stores the `nsfw` flag.
- **Toasts and errors name no hidden skin**: `redactHidden` swaps hidden skins' names and folders for "a hidden
  skin". Over-redacting is the safe direction; names under 3 characters match only as whole words.
- **Reveal hotkey rules**: Ctrl and/or Alt (Shift optional) plus exactly one other key, never Ctrl+S, Ctrl+Z, Ctrl+F
  or Alt+F4. Rust (`check_hotkey`) and TS (`revealHotkeyProblem`) apply the same rules and compare combos ignoring
  modifier order. A saved hotkey that breaks them falls back to Ctrl+H on load, instead of flagging the settings
  file and sending the app back to first-run setup.
- **Shortcuts resolve to actions** (`resolveShortcut`), and the UI decides what each means for the layout and focus.
  Ctrl/Alt combos work while typing, except Ctrl+Z, which undoes text there. Plain printable keys start a search,
  except I (peek) and Space (pick).
- **What the soft lock doesn't cover** (from the M8 review, accepted per SPEC §6): anyone who can read
  `settings.json` can brute-force a 4-digit PIN offline in minutes; the wrong-guess throttle resets when the app
  restarts; a corrupt `settings.json` falls back to `.bak`, which can hold the previous PIN; and the snapshot still
  carries hidden skins to the webview, where only the UI hides them. The PIN keeps an onlooker out, nothing more.
- **An unreadable stored hash counts as no PIN** (it doesn't parse, or its digest isn't full length). Failing the
  other way would lock both the reveal and the PIN itself behind a PIN nobody can enter.
- **Ctrl+V, Ctrl+A, Ctrl+C and Ctrl+X are reserved too**, so the reveal hotkey never hijacks paste or text editing.
- **Shortcut letters come from the physical key** (`e.code`), like the reveal hotkey, so Ctrl+S/F/Z work on
  non-Latin layouts. The Windows key belongs to the OS: any press with it held is ignored.
- **Minimize is caught from a resize or a focus loss** while minimized, so one skipped window event can't leave 18+
  skins showing. Still to confirm on Windows (WINDOWS-TESTING).
- **Arrow keys move by on-screen geometry** (`spatial.ts`), so no column counts are needed. Sideways distance is
  measured to the candidate's edge and weighted 3x, so Down picks the card below, or the shelf strip under the row.

## M9 Packaging

- **NSIS only, per-user install** (`installMode: currentUser`): no admin prompt, installs to
  `%LOCALAPPDATA%\Skin Switcher`. The app only writes to the user's own Mods, Library and AppData folders, so nothing
  needs machine-wide rights.
- **WebView2: embedded bootstrapper.** The installer skips it when WebView2 is already present (this PC has v155, and
  Windows 11 ships it); the offline installer would add about 127 MB to every build for a case that doesn't apply.
- **Unsigned.** There is no code-signing certificate; the testing guide explains the SmartScreen prompt.
- **Icons are still the scaffold's Tauri defaults** in `src-tauri/icons/`. Replacing them is a `npx tauri icon
  <1024px png>` away and doesn't change the config.
- **The testing guide uses a copy of the fixtures** (`D:\mods\ss-test`) with `SKIN_SWITCHER_CONFIG_DIR` pointing at
  a test settings folder, so the installed app can be tested without touching the real settings or Mods. The
  rollback and crash checks use the debug build's `SKIN_SWITCHER_FAULT` hook; the rollback check also has a
  locked-file variant that runs on the installed release build.
- **The guide targets `main` after M6.** Checks for UI the redesign brings (the PIN prompt, Ctrl+H, auto re-hide,
  GameBanana fetching) sit under "Skip until the redesign UI lands", and the 18+ checks use the toolbar chip. The
  README lists those features as planned.
- **Guide commands fail closed.** Each launch sets `SKIN_SWITCHER_CONFIG_DIR` and checks it on the same line as the
  launch, because a pasted block can run line by line and a `throw` on its own line wouldn't stop the next one. The
  backup and rollback run inside one `& { }` block for the same reason. `Snap` hashes file contents and skips only
  the `Library\tmp` folder itself, which the app deletes at every start.
