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
