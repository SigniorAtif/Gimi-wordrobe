// SPEC §6 A4 + §9 + §16: adding an archive through the real app. Archives are copied next to the throwaway world;
// the file dialog is answered by the debug-only SKIN_SWITCHER_E2E_PICK_ARCHIVE.
import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { click, importAll, launch, makeWorld, tree, waitFor } from "./harness.mjs";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/archives");

function archiveIn(world, name) {
  const p = join(world.dir, name);
  cpSync(join(fixtures, name), p);
  return p;
}

test("adding Bennett's archive files the skin, splits the nested sword out and leaves junk behind", async () => {
  const w = makeWorld("add");
  const archive = archiveIn(w, "bennett_beach.zip");
  const before = tree(w.mods);
  const count = (list, re) => list.filter((p) => re.test(p)).length;
  const app = await launch(w, { SKIN_SWITCHER_E2E_PICK_ARCHIVE: archive });
  try {
    const { browser } = app;
    await importAll(browser);
    await click(browser, "button=+ Add");
    await waitFor(browser, ".a4 .roots");
    // detected by hash: Bennett (new to this library), and his sword as its own weapon skin
    const entity = await browser.$(".a4__right select");
    assert.match(await entity.getText(), /Bennett/);
    const rows = await browser.$$(".roots__row");
    assert.equal(rows.length, 2);
    assert.equal(await rows[1].$('[role="radio"][aria-checked="true"]').getText(), "Its own skin");
    await click(browser, "button=Extract & add");
    const toast = await waitFor(browser, ".toast--success", 30000);
    assert.match(await toast.getText(), /Added .* to Bennett/);

    const mods = tree(w.mods);
    const lib = tree(w.lib);
    const all = [...mods, ...lib];
    const main = mods.find((p) => p.includes("BennettAdventure.ini"));
    assert.ok(main, "the main skin was made active, so it sits in Mods");
    const mainDir = main.slice(0, main.lastIndexOf("/") + 1);
    const sword = all.find((p) => p.includes("SkywardBlade.ini"));
    assert.ok(sword && !sword.startsWith(mainDir), `sword split out of the skin folder (${sword})`);
    // the fixture Mods folder has its own desktop.ini and ORFix copies on purpose; none may be added
    assert.equal(count(mods, /desktop\.ini/i), count(before, /desktop\.ini/i), "no desktop.ini added to Mods");
    assert.equal(count(lib, /desktop\.ini/i), 0, "no desktop.ini in the Library");
    assert.equal(count(mods, /ORFix\.ini/i), count(before, /ORFix\.ini/i), "no bundled ORFix copy added");
    assert.ok(lib.some((p) => /^previews\/.+\.png /.test(p)), "the archive's preview image was kept");
    // the new skin's shelf opens so it can be switched right away
    await waitFor(browser, '[data-shelf="bennett"]');
  } finally {
    await app.close();
  }
});

test("an archive with a ../ entry is rejected and nothing is written", async () => {
  const w = makeWorld("add-evil");
  const archive = archiveIn(w, "evil_traversal.zip");
  const beforeMods = tree(w.mods);
  const app = await launch(w, { SKIN_SWITCHER_E2E_PICK_ARCHIVE: archive });
  try {
    const { browser } = app;
    await importAll(browser);
    await waitFor(browser, '[data-entity="furina"]');
    const beforeLib = tree(w.lib);
    await click(browser, "button=+ Add");
    const toast = await waitFor(browser, ".toast--error");
    // the toast fades in, and WebDriver reports no text while it's still transparent
    await browser.waitUntil(async () => /Archive rejected/.test(await toast.getText()), {
      timeout: 5000,
      timeoutMsg: "the error toast says the archive was rejected",
    });
    await (await browser.$(".a4")).waitForExist({ reverse: true, timeout: 3000, timeoutMsg: "the dialog doesn't stay open" });
    assert.deepEqual(tree(w.mods), beforeMods);
    assert.deepEqual(tree(w.lib), beforeLib);
  } finally {
    await app.close();
  }
});
