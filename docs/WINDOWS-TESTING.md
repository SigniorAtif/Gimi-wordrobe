# Windows testing guide

> **Run this guide on `main` after PR #9 (first-run import) has merged.**

The app was built and tested on Linux against the fixtures. This guide covers what's left, all on Windows:
build the installer, run every acceptance check (SPEC §16) on a **copy of the fixtures**, and only then import the
real Mods folder.

Work through it top to bottom. Tick each box as you go. Allow about two hours the first time (most of it is the
first Rust build and the checks). Steps under **Skip until the redesign UI lands** need screens that aren't built
yet (the PIN prompt, the Ctrl+H shortcut, auto re-hide, GameBanana previews); leave those boxes for later.

> **Rule for the whole guide:** sections 1–5 never write to `D:\mods\3dmigoto`, and the app never opens a file inside
> it. The only use is in 5.11, where PowerShell copies two archives out of it into the test world. The setup screen
> pre-fills the real paths, so change them every time the guide says so. The real Mods folder comes last, in
> section 6, after a backup.

All commands are for **PowerShell**. Paths assume the project is at `D:\mods\skin-switcher`.

## 1. One-time setup

Node.js, npm, winget and the WebView2 runtime are already installed on this PC (checked 2026-10-19). Two things are
missing: the MSVC C++ Build Tools and Rust.

1. Install them (each one shows a UAC prompt; the Build Tools take a while):
   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   winget install Rustlang.Rustup
   ```
2. Close the terminal and open a new one so PATH updates.
3. Check:
   ```powershell
   rustc --version
   cargo --version
   rustup default        # should say stable-x86_64-pc-windows-msvc
   node --version
   ```

- [ ] `rustc`, `cargo` and `node` all print a version, and the Rust toolchain ends in `-msvc`.

## 2. Build

```powershell
cd D:\mods\skin-switcher
git pull
npm ci
npm run tauri build
```

- **`npm ci` is required after every switch from Linux.** `node_modules` holds native binaries (esbuild, rollup, the
  Tauri CLI) for the OS that installed them.
- The build first makes sure `src-tauri\resources\hash_index.json` exists (the character/weapon hash list, generated
  from GPL-3.0 data and never committed). If Linux generated it in the last 7 days it's reused, because the drive is
  shared. Otherwise it downloads the data from GitHub, so you need internet for this step.
- The first build compiles every Rust dependency: expect 5–15 minutes. Later builds are much faster.

The installer lands at:

```
D:\mods\skin-switcher\src-tauri\target\release\bundle\nsis\Skin Switcher_0.1.0_x64-setup.exe
```

Also build the **debug test build**. Two checks below need it, because only debug builds can fake a failure or a
crash in the middle of an Apply:

```powershell
npm run tauri build -- --debug --no-bundle
```

It lands at `D:\mods\skin-switcher\src-tauri\target\debug\skin-switcher.exe`.

- [ ] Both builds finish without errors and both files exist.

## 3. Install

1. Run `Skin Switcher_0.1.0_x64-setup.exe`.
2. Windows SmartScreen says "Windows protected your PC" because the installer isn't code-signed. Click
   **More info → Run anyway**.
3. It installs for your user only, so it doesn't ask for admin rights. It goes to
   `%LOCALAPPDATA%\Skin Switcher` and adds a **Skin Switcher** Start menu shortcut. If WebView2 were missing, the
   installer would install it (that needs internet); this PC already has it.

- [ ] The installer finishes and Skin Switcher appears in the Start menu and in Settings › Apps.

Don't open the app from the Start menu yet: that would use your real settings. Section 4 starts it with test settings.

## 4. Make a test world

The test world is a copy of the fixtures plus a separate Library and a separate settings folder, so nothing here can
reach your real Mods folder or real settings.

```powershell
$T = "D:\mods\ss-test"
robocopy "D:\mods\skin-switcher\fixtures" "$T\fixtures" /E /NFL /NDL /NJH /NJS
New-Item -ItemType Directory -Force "$T\Library", "$T\config" | Out-Null

# start the installed app with test settings (only for this PowerShell window)
$env:SKIN_SWITCHER_CONFIG_DIR = "$T\config"
$App = (Get-ChildItem "$env:LOCALAPPDATA\Skin Switcher\*.exe" | Where-Object Name -notlike "uninstall*" | Select-Object -First 1).FullName
if ($env:SKIN_SWITCHER_CONFIG_DIR -ne "D:\mods\ss-test\config") { throw 'set SKIN_SWITCHER_CONFIG_DIR first' }; & $App
```

> **Every launch in sections 4 and 5 sets `SKIN_SWITCHER_CONFIG_DIR` and runs that guard first, on the same line as
> the launch**, so the app can't start without the test settings even if a line is skipped. Without the variable the
> app uses the real settings in `%AppData%` and pre-fills the real Mods folder. Until section 6, never start the app
> from the Start menu or Explorer.

On the **Set up Skin Switcher** screen, replace the pre-filled real paths:

| Field | Value |
|---|---|
| Mod loader | 3DMigoto (standalone) |
| Mods folder | `D:\mods\ss-test\fixtures\Mods` |
| Library | `D:\mods\ss-test\Library` |

Two helpers for the checks. Paste them into the same PowerShell window. `Snap before` records every folder and file in
the test Mods folder and Library, plus `fixtures\d3dx_user.ini`, with a SHA-256 hash of each file's contents.
`Same before after` compares two snapshots, case-sensitively:

```powershell
function Snap($n) {
  $items = @(Get-ChildItem -Recurse -Force "$T\fixtures\Mods", "$T\Library") + @(Get-Item -Force -LiteralPath "$T\fixtures\d3dx_user.ini")
  $items | Where-Object FullName -ne "$T\Library\tmp" | ForEach-Object {
    $rel = $_.FullName.Substring($T.Length)
    if ($_.PSIsContainer) { "$rel\" } else { "$rel  $((Get-FileHash -LiteralPath $_.FullName).Hash)" }
  } | Sort-Object | Set-Content "$T\$n.txt" -Encoding UTF8
}
function Same($a, $b) { $d = Compare-Object -CaseSensitive (Get-Content "$T\$a.txt") (Get-Content "$T\$b.txt"); if ($d) { $d } else { "no differences" } }
```

`Snap` leaves out only the `Library\tmp` folder itself, because the app creates it on the first add and deletes it at
every start. Anything left inside it, such as staging files from a refused archive, shows up as a difference.

If you close this window, open a new one, paste these lines, then paste both helpers again:

```powershell
$T = "D:\mods\ss-test"
$env:SKIN_SWITCHER_CONFIG_DIR = "$T\config"
$App = (Get-ChildItem "$env:LOCALAPPDATA\Skin Switcher\*.exe" | Where-Object Name -notlike "uninstall*" | Select-Object -First 1).FullName
```

To start over at any point: close the app, delete `D:\mods\ss-test`, and run this section again.

### 4.1 First-run import on the fixtures

After setup, the app reads the fixture Mods folder and opens **Review your mods**. Nothing is moved until you press
Import.

- [ ] The "Reading your mods" card shows progress, then the list appears grouped by character, weapon and extra.
- [ ] **Sandrone**: one skin made of `sandrone_marionette_by_neyori\Face` + `outfit`, marked **by hash**.
- [ ] **A Teaspoon of Transcendence** is a separate **weapon** skin, not part of Sandrone.
- [ ] **Paimon**: `paimon_cc116`.
- [ ] Archives in `Charecters and wepon`: Bennett's archive (folder `Benny`) is a Bennett skin, and its sword is a
      separate **Skyward Blade** weapon skin named "Bennett Beach Day". Fischl's archive has **Oz** as a separate extra.
      Neuvillette's archive has **Tome of the Eternal Flow** as a separate weapon skin. The archive in `Veresa\nsfw`
      is marked 18+ (it shows as "Hidden 18+ skin" until you click the **18+ HIDDEN** chip above the list).
- [ ] Library mods (ORFix, ORFixAPI and the other global helpers) are not listed as skins. `desktop.ini` files and
      dot-folders don't appear.
- [ ] The loose `paimon_cc116.zip` and `sandrone_marionette_by_neyori.zip` are offered for moving to the Library, and
      "Move the imported archives" is ticked.
- [ ] Furina has two skins on (Remembrance and Casual), so the "Several skins are on" box asks which one to keep.
      Choose **Leave them all on** for now; check 5.1 switches them.
- [ ] Change one row's character with its dropdown: the row glides into the other group. "Something else…" lets you
      name a new character.
- [ ] Press **Import**. A toast confirms, and the home screen shows the imported skins. In
      `D:\mods\ss-test\Library\archives\` the archives sit in one folder per character.

### 4.2 Shortcut and look checks

- [ ] Ctrl+F (or just typing) focuses search; arrow keys move between cards; Enter opens; Space picks; I opens the
      quick peek (Shelves) or the detail page (Pages); Esc/Backspace goes back; Ctrl+S applies; Ctrl+Z undoes the last
      pending change. Shortcuts do nothing while another window is focused.
- [ ] Settings › Appearance › Reduce motion = **On**: only crossfades, no sliding or stagger. **System** follows
      Windows Settings › Accessibility › Visual effects › Animation effects.

**Skip until the redesign UI lands:**

- [ ] Ctrl+H toggles 18+ skins (SPEC §12).

## 5. Acceptance checks (SPEC §16) on the test world

Use the test world from section 4 for every check. Each check says how to see the result on disk.

### 5.1 One enabled copy per character

1. Open Furina's shelf (or her page in Pages mode), pick **Casual**, press **Apply** (or Ctrl+S).
2. Check:
   ```powershell
   dir "$T\fixtures\Mods\Furina"
   dir "$T\Library\stash\Furina"
   ```

- [ ] `Mods\Furina` holds only `Casual` (plus the untouched `DISABLED_Old`); `Remembrance` is now in
      `Library\stash\Furina`. The red "!" on Furina's card is gone.

### 5.2 A failed Apply rolls everything back

**a) A locked file (installed app).** Windows can't move a folder while a file inside it is open.

1. Pick changes for two characters, e.g. Kazuha › Original and Furina › Remembrance. Don't apply yet.
2. Record the trees and lock a file in one of the folders that will move:
   ```powershell
   Snap before
   $h = [System.IO.File]::Open("$T\fixtures\Mods\Kazuha\Multi\merged.ini", 'Open', 'Read', 'None')
   ```
3. Press **Apply**. It retries once, then fails.
4. Unlock and compare (unlock first: `Snap` can't hash a locked file):
   ```powershell
   $h.Close()
   Snap after; Same before after
   ```
5. Press **Apply** again.

- [ ] The error names the folder that was in use, `Same` prints `no differences`, and the second Apply works.

**b) A forced failure (debug build).** Close the app first, then:

```powershell
$env:SKIN_SWITCHER_CONFIG_DIR = "$T\config"
$env:SKIN_SWITCHER_FAULT = "fail:2"          # fail before the 2nd operation of the next Apply
if ($env:SKIN_SWITCHER_CONFIG_DIR -ne "D:\mods\ss-test\config") { throw 'set SKIN_SWITCHER_CONFIG_DIR first' }; & "D:\mods\skin-switcher\src-tauri\target\debug\skin-switcher.exe"
```

Pick changes for two characters, run `Snap before`, press Apply, then `Snap after; Same before after`. Afterwards
close the app, clear the fault and start the installed app again:

```powershell
Remove-Item Env:SKIN_SWITCHER_FAULT
$env:SKIN_SWITCHER_CONFIG_DIR = "$T\config"
if ($env:SKIN_SWITCHER_CONFIG_DIR -ne "D:\mods\ss-test\config") { throw 'set SKIN_SWITCHER_CONFIG_DIR first' }; & $App
```

- [ ] Apply reports the failure, the pending picks are still there, and `Same` prints `no differences`.

### 5.3 Move mode: the same path every time

Settings › Library › Disable method should be **Move** (the default).

1. Pick Furina › Remembrance and apply: `Mods\Furina\Remembrance` exists.
2. Pick Furina › Casual and apply: Remembrance moves to `Library\stash\Furina\Remembrance`.
3. Pick Remembrance again and apply.

- [ ] It's back at exactly `Mods\Furina\Remembrance` (same spelling and case). Do the same with Sandrone: her
      `Face` and `outfit` folders return to `Mods\sandrone_marionette_by_neyori\`.

### 5.4 Conflicts show before Apply

1. Pick skins that share a key: Kazuha › Multi and Furina › Remembrance both use key 6, and so does Mona › Starry
   Witch.
2. Look at the pending bar and the shelf before applying.
3. Set one of them back to Original.

- [ ] A conflict (or the muted overlap note for gated keys) shows before Apply and disappears as soon as the pick
      changes, without applying.

### 5.5 18+ skins leave no trace while hidden

1. Make sure at least one skin is 18+ (the Varesa archive from the import, or switch on **18+** on any skin's detail
   page).
2. Settings › NSFW › When hidden = **Fully invisible**. (The default, a small "+N" stub, shows how many are hidden on
   purpose.)
3. Click the toolbar's 18+ chip until it reads **18+ HIDDEN**.

- [ ] No 18+ name, cover or count shows anywhere: Shelves, Pages, character pages, the pending bar, toasts, and search
      (type the skin's name: no result). A character whose active skin is 18+ shows "Modded (hidden)" with a
      placeholder cover.
- [ ] Click the chip: it reads **18+ VISIBLE** and the 18+ skins appear. Click it again: they're hidden.
- [ ] Hidden is the default. Reveal the 18+ skins, close the app and start it again:
      ```powershell
      $env:SKIN_SWITCHER_CONFIG_DIR = "$T\config"
      if ($env:SKIN_SWITCHER_CONFIG_DIR -ne "D:\mods\ss-test\config") { throw 'set SKIN_SWITCHER_CONFIG_DIR first' }; & $App
      ```
      It opens with the chip on **18+ HIDDEN** and no 18+ skin showing.

**Skip until the redesign UI lands:**

- [ ] Ctrl+H toggles 18+ skins the same way the chip does.
- [ ] Settings › NSFW: set a PIN. Revealing now asks for it, and a wrong PIN doesn't reveal anything.
- [ ] With **Auto re-hide** on, minimise the window after revealing: 18+ skins are hidden again when you come back.

### 5.6 Removing goes to the Recycle Bin

1. Right-click a skin in a shelf (or use its menu on a character page) → **Remove…** → **Move to Recycle Bin**.
2. Open the Recycle Bin.

- [ ] The skin's folder is in the Recycle Bin, with its original location inside the test world. The skin is gone
      from the app. Restoring it and pressing Settings › Library › **Re-scan now** offers it for import again.

### 5.7 Both layouts at 1000×700

The window can't get smaller than 1000×700. Drag it to its smallest size.

- [ ] Shelves: no horizontal scrollbar; opening a shelf and the quick peek fit.
- [ ] Settings › Appearance › Layout = **Pages**: no horizontal scrollbar; a character page and a skin's detail
      page fit.
- [ ] Switching layouts keeps your place: an open shelf becomes the focused card, and back.

### 5.8 Every transition animates

WebView2 is the real target for motion, so judge it here. Walk through SPEC §7's table:

- [ ] App launch: the toolbar fades down, then the cards stagger in.
- [ ] Home ↔ character page: the portrait morphs into the page header and back.
- [ ] Skin card → detail page: the cover morphs into the big preview; prev/next slides in the right direction.
- [ ] A shelf springs open; opening another closes the old one without a jump. The quick peek morphs.
- [ ] Picking a skin: the dot pops, the ACTIVE / PENDING tag slides between cards.
- [ ] Pending bar slides up and its count ticks. Apply morphs into progress and then a check mark. Toasts spring in.
- [ ] Dialogs (add, confirm) scale in over a blurred backdrop; menus scale from their trigger.
- [ ] Dragging an archive over the window: cards pulse, the hovered one lifts, "+ New" tiles slide in.
- [ ] Search: filtered cards fade out and the rest reflow. 18+ reveal: cards un-blur in a stagger.
- [ ] Layout switch: the main area crossfades. Hover lifts cards; pressing shrinks them slightly.
- [ ] Nothing snaps anywhere, and clicking during an animation retargets it smoothly.

### 5.9 Archives: no ORFix copies, no junk, no escape

1. **+ Add** → `D:\mods\ss-test\fixtures\archives\bennett_beach.zip` → **Extract & add**.
   ```powershell
   Get-ChildItem -Recurse -Force "$T\fixtures\Mods", "$T\Library\stash" -Include desktop.ini, ORFix.ini | Select-Object FullName
   ```
- [ ] The only results are the fixture's own `Mods\ORFix.ini` and `Mods\Furina\Remembrance\desktop.ini` from
      before. Nothing new from the archive: no `BufferValues\ORFix.ini` copy, no `desktop.ini`.

2. Add `D:\mods\ss-test\fixtures\archives\mona_starry_skin.zip`.
- [ ] No `__MACOSX` folder and no `desktop.ini` end up in the new skin. `MonaBodyDiffuse.png` (a texture) isn't
      used as a preview; `preview1.png` is.

3. Run `Snap before`, add `evil_traversal.zip`, then `evil_absolute.zip`, then `Snap after; Same before after`.
- [ ] Both are refused with a message, and `Same` prints `no differences`.

### 5.10 A crash in the middle of an Apply

Close the app, then:

```powershell
Snap before
$env:SKIN_SWITCHER_CONFIG_DIR = "$T\config"
$env:SKIN_SWITCHER_FAULT = "crash:2"
if ($env:SKIN_SWITCHER_CONFIG_DIR -ne "D:\mods\ss-test\config") { throw 'set SKIN_SWITCHER_CONFIG_DIR first' }; & "D:\mods\skin-switcher\src-tauri\target\debug\skin-switcher.exe"
```

1. Pick changes for two characters and press Apply. The app closes by itself.
2. Check that `D:\mods\ss-test\Library\apply-journal.json` exists.
3. Start the app again without the fault:
   ```powershell
   Remove-Item Env:SKIN_SWITCHER_FAULT
   $env:SKIN_SWITCHER_CONFIG_DIR = "$T\config"
   if ($env:SKIN_SWITCHER_CONFIG_DIR -ne "D:\mods\ss-test\config") { throw 'set SKIN_SWITCHER_CONFIG_DIR first' }; & "D:\mods\skin-switcher\src-tauri\target\debug\skin-switcher.exe"
   ```
4. After it opens, run `Snap after; Same before after`.

- [ ] The app says the last Apply was interrupted and was undone, the journal file is gone, and `Same` prints
      `no differences`.

Close the debug build and start the installed app again for the rest of the checks:

```powershell
$env:SKIN_SWITCHER_CONFIG_DIR = "$T\config"
if ($env:SKIN_SWITCHER_CONFIG_DIR -ne "D:\mods\ss-test\config") { throw 'set SKIN_SWITCHER_CONFIG_DIR first' }; & $App
```

### 5.11 Windows-only archive checks

These code paths can't run on Linux. Two of them need real archives. Copy those into the test world first; the app
only ever adds the copies:

```powershell
$Real = "D:\mods\3dmigoto\Mods\Charecters and wepon"     # read-only: only ever a copy source
Copy-Item -LiteralPath "$Real\Diluc\dilucinwhitebetterhair.rar" "$T\fixtures\archives\"
Copy-Item -LiteralPath "$Real\Veresa\nsfw\varesa_lewd_-_culott_e_mort_1828d.zip" "$T\fixtures\archives\"
```

1. **A real .rar**: **+ Add** → `D:\mods\ss-test\fixtures\archives\dilucinwhitebetterhair.rar`.
   - [ ] It lists and extracts through Windows' `tar.exe`, and its `prev (1..6).png` images become previews.
2. **A non-ASCII archive name**:
   ```powershell
   Copy-Item "$T\fixtures\archives\mona_starry_skin.zip" "$T\Culottée à mort 八重.zip"
   ```
   The `八重` characters are outside the Western code page, which is what breaks badly encoded command lines.
   - [ ] Adding `D:\mods\ss-test\Culottée à mort 八重.zip` works, and the file name shows correctly in the add
         dialog.
3. **A non-ASCII folder inside an archive**: add the copy at
   `D:\mods\ss-test\fixtures\archives\varesa_lewd_-_culott_e_mort_1828d.zip` (it's 18+; keep it marked 18+).
   - [ ] The folder shows as `Culottée à mort` (or a cleaned-up readable name), never with `�` characters. Its inner
         `DISABLED…` folders keep their names.
4. **A read-only `desktop.ini`**:
   ```powershell
   $S = "$T\ro-src\ReadOnlyTest"
   New-Item -ItemType Directory -Force $S | Out-Null
   Copy-Item "$T\fixtures\Mods\Mona\Starry Witch\MonaCN.ini" $S
   Set-Content "$S\desktop.ini" "[.ShellClassInfo]"
   attrib +r +h +s "$S\desktop.ini"
   tar.exe -a -c -f "$T\readonly_desktop_ini.zip" -C "$T\ro-src" ReadOnlyTest
   ```
   After adding it, check the staging folder (this prints nothing when it's empty or gone):
   ```powershell
   Get-ChildItem -Force "$T\Library\tmp" -ErrorAction SilentlyContinue
   ```
   - [ ] Adding `readonly_desktop_ini.zip` works without an "access denied" error, no `desktop.ini` is placed, and
         `D:\mods\ss-test\Library\tmp` is empty afterwards.
5. **The 7-Zip / UnRAR fallback**: the app only uses these when `tar.exe` can't read an archive. WinRAR is installed
   (`C:\Program Files\WinRAR\UnRAR.exe`); 7-Zip is used if it's in `C:\Program Files\7-Zip`. One way to make an
   archive `tar.exe` may not read is a RAR split into volumes. Build it from a copy under the test world, with the
   output in `$T\split\`:
   ```powershell
   $S = "$T\split-src\SplitTest"
   New-Item -ItemType Directory -Force $S, "$T\split" | Out-Null
   Copy-Item "$T\fixtures\Mods\Mona\Starry Witch\MonaCN.ini" $S
   $b = New-Object byte[] 65536; (New-Object Random 1).NextBytes($b); [IO.File]::WriteAllBytes("$S\filler.buf", $b)
   & "C:\Program Files\WinRAR\Rar.exe" a -r -ep1 -v20k "$T\split\splittest.rar" $S
   ```
   (Or in WinRAR's window: add `D:\mods\ss-test\split-src\SplitTest` with **Split to volumes** = 20 KB and the
   archive name `D:\mods\ss-test\split\splittest.rar`.) You get `splittest.part1.rar`, `splittest.part2.rar`, … in
   `D:\mods\ss-test\split\`. Then add `D:\mods\ss-test\split\splittest.part1.rar`.
   - [ ] Either `tar.exe` reads it, or the fallback does and the skin is added with the same checks (no junk, no
         unsafe paths). Write down which happened. If neither can read it, the app should say so and write nothing.
6. **Native dialogs**:
   - [ ] **+ Add** opens a Windows file dialog filtered to `.zip`, `.rar` and `.7z`.
   - [ ] Settings' **Browse** buttons open a folder picker.
   - [ ] Choosing a preview or portrait image opens a picker filtered to images.
7. **GameBanana previews. Skip until the redesign UI lands:** the current UI doesn't fetch from GameBanana yet.
   Later: paste a GameBanana mod link (e.g. a `https://gamebanana.com/mods/<id>` page) into a skin.
   - [ ] A shimmer shows while it fetches, then the mod's preview images appear. With the network off, it falls back
         to "+ Add preview" with a Retry link.
8. **Library on another drive** (optional): in the test settings, set the Library to `C:\ss-test-lib`.
   - [ ] Settings warns that switching becomes a copy, and Apply shows progress and still ends with one enabled copy.
         Set the Library back afterwards.

### 5.12 In-mod toggles survive a switch (fixture half)

SPEC §16's toggle check needs the game, so its in-game half waits for 6.4. This half runs on the test world. The
fixture `d3dx_user.ini` already holds Sandrone's `hat = 2`.

1. Check the line:
   ```powershell
   $U = "$T\fixtures\d3dx_user.ini"
   Select-String -SimpleMatch "outfit\sandrone.ini\hat" $U
   ```
2. Pick Sandrone › Original and Apply.
3. Do what the game does when it exits with her mod off: drop her `Face` and `outfit` lines from the file.
   ```powershell
   (Get-Content $U) | Where-Object { $_ -notlike '$\mods\sandrone_marionette_by_neyori\face\*' -and $_ -notlike '$\mods\sandrone_marionette_by_neyori\outfit\*' } | Set-Content $U -Encoding ASCII
   Select-String -SimpleMatch "outfit\sandrone.ini\hat" $U     # prints nothing now
   ```
4. Pick Sandrone's mod again and Apply. Then check the line once more:
   ```powershell
   Select-String -SimpleMatch "outfit\sandrone.ini\hat" $U
   ```

- [ ] Step 1 and step 4 both print the `$\mods\sandrone_marionette_by_neyori\outfit\sandrone.ini\hat` line, and it
      still ends in `= 2`.

## 6. The real Mods folder

Only start once every box in sections 4 and 5 is ticked (or you've decided a failure doesn't matter). From here on
the app changes real files, and it moves the archive library out of Mods.

### 6.1 Back up first

Close the game and the 3DMigoto loader. Then copy the whole loader folder, including `d3dx_user.ini`:

```powershell
$B = "D:\mods\3dmigoto-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
& {
  if (Test-Path $B) { throw "backup folder exists: $B" }
  robocopy "D:\mods\3dmigoto" $B /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
  $src = Get-ChildItem -Recurse -Force -File "D:\mods\3dmigoto" | Measure-Object Length -Sum
  $dst = Get-ChildItem -Recurse -Force -File $B | Measure-Object Length -Sum
  "source: $($src.Count) files, $($src.Sum) bytes"
  "backup: $($dst.Count) files, $($dst.Sum) bytes"
  if ($src.Count -ne $dst.Count -or $src.Sum -ne $dst.Sum) { throw "the backup doesn't match the source" }
  "Backup OK: $B"
}
```

The block refuses to write into a backup folder that already exists, stops if robocopy fails (exit code 8 or more),
and compares the file count and total bytes on both sides. Write down the folder it prints: 6.5 needs it.

- [ ] The block ends with `Backup OK: D:\mods\3dmigoto-backup-…`, and the `source` and `backup` lines show the same
      file count and bytes.

### 6.2 Run the first-run import

1. Open a **new** PowerShell window, or use the Start menu shortcut, so `SKIN_SWITCHER_CONFIG_DIR` isn't set. The app
   now uses the real settings folder, `%AppData%\com.signioratif.skinswitcher`.
2. On the setup screen, keep the pre-filled real paths:

   | Field | Value |
   |---|---|
   | Mod loader | 3DMigoto (standalone) |
   | Mods folder | `D:\mods\3dmigoto\Mods` |
   | Library | `D:\mods\SkinLibrary` |

3. Wait for **Review your mods** (reading every archive takes a minute or two). Check:

- [ ] **Sandrone**: `sandrone_marionette_by_neyori` (`Face` + `outfit`) is one skin, found **by hash**.
- [ ] **A Teaspoon of Transcendence** is a separate weapon skin.
- [ ] **Paimon**: `paimon_cc116`.
- [ ] Every archive under `Charecters and wepon` is a skin of its folder's character (`Benny` = Bennett,
      `Neuvilette` = Neuvillette, `Veresa` = Varesa, `Tome_of_Eternal` = the weapon Tome of the Eternal Flow).
- [ ] Bennett's beach archive: the sword is a separate **Skyward Blade** weapon skin.
- [ ] Fischl's Hexenzirkel archive: **Oz** is a separate extra under Fischl.
- [ ] Neuvillette's wedding archive: the **Tome of the Eternal Flow** recolor is a separate weapon skin. The
      `www.patreon.com annplan.png` promo image isn't the cover.
- [ ] Alyosha is found even though the ini is spelled `Aloysha.ini`.
- [ ] Varesa: `varesa_by_neyori` is one skin (Face + Outfit) and isn't 18+. The three skins in `Veresa\nsfw` are 18+
      (click the **18+ HIDDEN** chip to check their names).
- [ ] Libraries (ORFix, ORFixAPI and other global helpers) aren't listed as skins.
- [ ] No archive is listed as unreadable. If one is, write down its name and the message.
- [ ] The loose `paimon_cc116.zip` and `sandrone_marionette_by_neyori.zip` are offered for moving to the Library,
      and "Move the imported archives to D:\mods\SkinLibrary\archives" is ticked.

4. Fix anything wrong with the row's dropdown (or "Something else…"), pick which skin stays on where the app asks,
   then press **Import**.

### 6.3 After the import

```powershell
dir "D:\mods\3dmigoto\Mods"
dir "D:\mods\SkinLibrary\archives"
Get-ChildItem -Recurse -Force "D:\mods\3dmigoto\Mods" -Include desktop.ini, ORFix.ini | Select-Object FullName
```

- [ ] `Mods` holds the enabled skins and the libraries. `Charecters and wepon` is gone from Mods, and its archives are
      in `D:\mods\SkinLibrary\archives\<Character>\`.
- [ ] The only `ORFix.ini` is the global one that was there before, and no new `desktop.ini` appeared inside an
      imported skin.
- [ ] Start the game through the loader: the active skins load, and F10 (reload) shows no duplicate-ORFix errors.

### 6.4 In-game toggles survive a switch (SPEC §16)

This is the in-game half of 5.12.

1. Start the game, set a toggle in game (e.g. cycle Sandrone's hat to its third option, `hat = 2`), and exit the
   game.
2. In the app, switch Sandrone to another skin (or Original) and Apply. Then switch back to her mod and Apply.
3. Check the file, then start the game again:
   ```powershell
   Select-String -SimpleMatch "outfit\sandrone.ini\hat" "D:\mods\3dmigoto\d3dx_user.ini"
   ```

- [ ] The line still ends in `= 2`, and in game the hat is still on its third option.

### 6.5 If something goes wrong

Close the app, the game and the loader, then put the backup back. The current Mods folder is renamed and the current
`d3dx_user.ini` is copied aside, both with a timestamp, so nothing is lost. If this is a new PowerShell window, first
set `$B` to the folder 6.1 printed (e.g. `$B = "D:\mods\3dmigoto-backup-20261101-203000"`).

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $L = "D:\mods\3dmigoto"
  $stamp = Get-Date -Format yyyyMMdd-HHmmss
  if (-not $B -or -not (Test-Path "$B\Mods")) { throw "no backup at '$B\Mods'. Set the B variable to the folder 6.1 printed." }
  if (Test-Path "$L\Mods") { Rename-Item "$L\Mods" "Mods-after-import-$stamp" }
  if (Test-Path "$L\Mods") { throw "$L\Mods still exists, so nothing was copied over it" }
  robocopy "$B\Mods" "$L\Mods" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
  if (Test-Path "$L\d3dx_user.ini") { Copy-Item "$L\d3dx_user.ini" "$L\d3dx_user.ini.after-import-$stamp" }
  Copy-Item "$B\d3dx_user.ini" "$L\d3dx_user.ini" -Force
  "Restored from $B. The previous Mods folder is now $L\Mods-after-import-$stamp"
}
```

The block stops at the first error, and it never copies the backup over a Mods folder that still exists.

To make the app start fresh as well, rename `D:\mods\SkinLibrary` and `%AppData%\com.signioratif.skinswitcher`.
The app also keeps the first `d3dx_user.ini` it ever changed as `d3dx_user.ini.skinswitcher-original` next to it.

### 6.6 Later: moving to XXMI

XXMI isn't installed yet. When it is:

1. Settings › Mod loader → **XXMI**, and set its Mods folder to `%AppData%\XXMI Launcher\GIMI\Mods` if it isn't
   filled in already. The app then reads and writes `%AppData%\XXMI Launcher\GIMI\d3dx_user.ini` (the file next to
   that Mods folder).
2. If you switch Settings › Library › Disable method to **Prefix** (`DISABLED_` names), open
   `%AppData%\XXMI Launcher\GIMI\d3dx.ini` and check it contains `exclude_recursive = DISABLED*`. Move mode (the
   default) doesn't depend on it.
3. Keep the Library on the same drive as the new Mods folder, or every switch becomes a copy.

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| `link.exe not found` or `msvc` errors during the build | The Build Tools are missing the C++ workload. Re-run the winget command in section 1, or open Visual Studio Installer → Modify → tick **Desktop development with C++**. |
| `npm ci` fails with `EPERM` / `EBUSY` | Close editors and terminals that use the project, then try again. Antivirus scanning `node_modules` can cause it too. |
| The build says the hash index failed and no previous index exists | It needs GitHub. Check the internet connection; if GitHub's API limit was hit, wait an hour. Or build once on Linux (`npm run hash-index`): the file lands in `src-tauri\resources` on the shared drive. |
| The app opens to a blank or white window, or says WebView2 is missing | Install the Evergreen WebView2 Runtime from Microsoft, then start the app again. |
| "Windows protected your PC" | The installer isn't signed. **More info → Run anyway.** |
| Antivirus deletes or quarantines the installer or the exe | Restore it from Windows Security › Protection history, then add an exclusion for `%LOCALAPPDATA%\Skin Switcher` (and for `D:\mods\skin-switcher\src-tauri\target` while building). |
| Adding an archive fails on a very long path inside it | Windows limits paths to 260 characters unless long paths are on. Keep the Library path short (`D:\mods\SkinLibrary`), or enable long paths once (admin PowerShell): `New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force`, then restart. |
| Apply says a folder is in use | Something holds a file open: the game, an Explorer window showing that folder, or an image viewer. Close it and press Apply again. Nothing was changed. |
| "Mods folder changed outside the app — re-scanned" | Something else changed Mods since the app last looked (the game, Explorer, another tool). Check your picks and press Apply again. |
| The Library is on another drive | Allowed, but every switch becomes a copy, verify and delete instead of an instant move. Settings › Library shows a warning. Keep both on `D:` if you can. |

Settings live in `%AppData%\com.signioratif.skinswitcher\settings.json` (or in `SKIN_SWITCHER_CONFIG_DIR` when that
is set). The library list is `<Library>\library.json`.
