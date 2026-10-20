// SPEC §5 + §16: the first-run import of the Mods folder and its archive library, through the real app.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { click, launch, makeWorld, tree, waitFor } from "./harness.mjs";

test("first run imports installed mods in place and the archive library, then files the archives in the Library", async () => {
  const w = makeWorld("import", { archives: true });
  const before = tree(w.mods);
  const app = await launch(w);
  try {
    const { browser } = app;
    await waitFor(browser, ".imp__foot .btn--primary", 30000);
    // read every group name in one script call (fourteen concurrent element reads lost the WebDriver session)
    const groups = await browser.execute(() => Array.from(globalThis.document.querySelectorAll(".imp-group__name"), (g) => g.textContent));
    for (const name of ["Sandrone", "Paimon", "Furina", "Bennett", "Skyward Blade", "Fischl", "Oz", "Neuvillette", "Tome of the Eternal Flow"]) {
      assert.ok(groups.includes(name), `${name} is proposed (got ${groups.join(", ")})`);
    }
    // Furina has two skins switched on; keep Remembrance, the other goes to the stash
    await click(browser, ".imp-pill=Remembrance");
    await click(browser, ".imp__foot .btn--primary");
    const toast = await waitFor(browser, ".toast--success", 60000);
    assert.match(await toast.getText(), /Imported \d+ skins/);
    await waitFor(browser, '[data-entity="oz"]');

    const mods = tree(w.mods);
    const lib = tree(w.lib);
    const inis = (t) => t.filter((p) => /\.ini \d+$/i.test(p)).map((p) => p.replace(/ \d+$/, ""));
    // installed mods stay where they are
    assert.ok(existsSync(join(w.mods, "Kazuha/Multi/merged.ini")));
    assert.ok(existsSync(join(w.mods, "Furina/Remembrance/Furina.ini")));
    assert.ok(!existsSync(join(w.mods, "Furina/Casual")));
    assert.ok(existsSync(join(w.lib, "stash/Furina/Casual/Furina.ini")), "the other Furina skin went to the stash");
    // archive skins arrive switched off: nothing new is placed into Mods, no junk or bundled ORFix anywhere
    assert.ok(
      inis(mods).every((p) => inis(before).includes(p)),
      "no new .ini in Mods",
    );
    assert.equal(lib.filter((p) => /desktop\.ini/i.test(p)).length, 0, "no desktop.ini in the Library");
    assert.equal(lib.filter((p) => /ORFix/i.test(p)).length, 0, "no ORFix copy in the Library");
    // imported archives move to <Library>/archives/<entity>/, loose ones to <Library>/archives/
    assert.ok(existsSync(join(w.lib, "archives/Bennett/bennett_beach.zip")));
    assert.ok(existsSync(join(w.lib, "archives/Fischl/fischl_hexenzirkel.zip")));
    assert.ok(!existsSync(join(w.mods, "Charecters and wepon/Benny")), "emptied archive folders are removed");
    assert.ok(existsSync(join(w.mods, "Charecters and wepon/desktop.ini")), "folders with other files stay");
    assert.ok(existsSync(join(w.lib, "archives/paimon_cc116.zip")));
    assert.ok(!existsSync(join(w.mods, "paimon_cc116.zip")));

    const library = JSON.parse(readFileSync(join(w.lib, "library.json"), "utf8"));
    const byName = (n) => library.entities.find((e) => e.name === n);
    assert.equal(byName("Oz")?.parentId, byName("Fischl")?.id, "Oz sits under Fischl");
    assert.equal(byName("Skyward Blade")?.category, "weapon");
    assert.equal(byName("Tome of the Eternal Flow")?.category, "weapon");
    assert.equal(byName("A Teaspoon of Transcendence")?.category, "weapon");
  } finally {
    await app.close();
  }
});

test("skipping the review changes nothing on disk", async () => {
  const w = makeWorld("import-skip", { archives: true });
  const before = tree(w.mods);
  const app = await launch(w);
  try {
    const { browser } = app;
    await click(browser, "button=Skip for now");
    await waitFor(browser, ".toolbar");
    assert.deepEqual(tree(w.mods), before);
    assert.ok(!existsSync(join(w.lib, "library.json")) || JSON.parse(readFileSync(join(w.lib, "library.json"), "utf8")).skins.length === 0);
  } finally {
    await app.close();
  }
});
