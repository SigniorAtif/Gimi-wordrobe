// SPEC §16: Apply leaves one enabled skin, a failed Apply rolls back, a killed Apply is undone on restart.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { click, importAll, launch, makeWorld, sleep, tree, waitFor } from "./harness.mjs";

async function pickFurinaCasual(browser) {
  await click(browser, '[data-entity="furina"]');
  await click(browser, '[data-shelf="furina"] [data-skin="furina--casual"] .skincard__hit');
  await waitFor(browser, ".pending");
}

test("apply switches Furina to Casual and leaves exactly one Furina skin in Mods", async () => {
  const w = makeWorld("apply");
  const app = await launch(w);
  try {
    const { browser } = app;
    await importAll(browser);
    await pickFurinaCasual(browser);
    await click(browser, ".pending__apply");
    const toast = await waitFor(browser, ".toast--success");
    assert.match(await toast.getText(), /Applied/);
    assert.ok(existsSync(join(w.mods, "Furina/Casual/Furina.ini")));
    assert.ok(!existsSync(join(w.mods, "Furina/Remembrance")));
    assert.ok(existsSync(join(w.lib, "stash/Furina/Remembrance/Furina.ini")), "same relative path in the stash");
    assert.ok(!existsSync(join(w.lib, "apply-journal.json")));
    assert.equal(await browser.getTitle(), "Applied — press F10");
  } finally {
    await app.close();
  }
});

test("a failing apply rolls everything back and says so", async () => {
  const w = makeWorld("rollback");
  const app = await launch(w, { SKIN_SWITCHER_FAULT: "fail:1" });
  try {
    const { browser } = app;
    await importAll(browser);
    const before = tree(w.mods);
    await pickFurinaCasual(browser);
    await click(browser, '[data-entity="sandrone"]');
    await click(browser, '[data-shelf="sandrone"] [data-skin="original"]');
    await click(browser, ".pending__apply");
    const toast = await waitFor(browser, ".toast--error");
    assert.match(await toast.getText(), /Apply failed/);
    assert.deepEqual(tree(w.mods), before, "Mods is exactly as before");
    assert.ok(!existsSync(join(w.lib, "apply-journal.json")));
  } finally {
    await app.close();
  }
});

test("killing the app mid-apply is undone on the next start", async () => {
  const w = makeWorld("crash");
  let before;
  let app = await launch(w, { SKIN_SWITCHER_FAULT: "crash:3" });
  try {
    await importAll(app.browser);
    before = tree(w.mods);
    await click(app.browser, '[data-entity="sandrone"]');
    await click(app.browser, '[data-shelf="sandrone"] [data-skin="original"]');
    await click(app.browser, ".pending__apply");
    await sleep(2500); // the app exits mid-batch
  } finally {
    await app.close();
  }
  assert.ok(existsSync(join(w.lib, "apply-journal.json")), "journal left behind");
  assert.notDeepEqual(tree(w.mods), before);
  app = await launch(w);
  try {
    const toast = await waitFor(app.browser, ".toast--info");
    assert.match(await toast.getText(), /interrupted/);
    assert.deepEqual(tree(w.mods), before, "restored");
    assert.ok(!existsSync(join(w.lib, "apply-journal.json")));
  } finally {
    await app.close();
  }
});
