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
