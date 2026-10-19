// End-to-end harness: drives the real app through tauri-driver (WebKitWebDriver on Linux) against a throwaway
// copy of fixtures/Mods. Never touches a real Mods folder.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = process.env.SKIN_SWITCHER_E2E_BIN ?? join(homedir(), ".cache/skin-switcher-e2e/skin-switcher-e2e");
const DRIVER = process.env.TAURI_DRIVER ?? join(homedir(), ".cargo/bin/tauri-driver");
const WORLDS = join(homedir(), ".cache/skin-switcher-e2e/worlds");

/** A fresh world: Mods (fixture copy), d3dx_user.ini, Library and a config dir with settings pointing at them. */
export function makeWorld(name) {
  const dir = join(WORLDS, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "cfg"), { recursive: true });
  cpSync(join(root, "fixtures/Mods"), join(dir, "Mods"), { recursive: true });
  cpSync(join(root, "fixtures/d3dx_user.ini"), join(dir, "d3dx_user.ini"));
  const settings = {
    activeLoader: "3dmigoto",
    modsPath: { "3dmigoto": join(dir, "Mods") },
    libraryPath: join(dir, "SkinLibrary"),
    disableMethod: "move",
    layout: "shelves",
    reduceMotion: "on",
    nsfw: { hotkey: "Ctrl+H", whenHidden: "stub", autoRehide: false },
  };
  writeFileSync(join(dir, "cfg/settings.json"), JSON.stringify(settings, null, 2));
  return { dir, mods: join(dir, "Mods"), lib: join(dir, "SkinLibrary"), cfg: join(dir, "cfg") };
}

/** Every path under a folder with file sizes, sorted (for before/after comparisons). */
export function tree(base) {
  const out = [];
  const walk = (p) => {
    if (!existsSync(p)) return;
    for (const n of readdirSync(p)) {
      const full = join(p, n);
      const st = statSync(full);
      if (st.isDirectory()) {
        out.push(`${relative(base, full)}/`);
        walk(full);
      } else out.push(`${relative(base, full)} ${st.size}`);
    }
  };
  walk(base);
  return out.sort();
}

function waitPort(port, ms = 15000) {
  const until = Date.now() + ms;
  return new Promise((ok, fail) => {
    const tryOnce = () => {
      const s = createConnection({ port, host: "127.0.0.1" }, () => {
        s.end();
        ok();
      });
      s.on("error", () => (Date.now() > until ? fail(new Error(`port ${port} never opened`)) : setTimeout(tryOnce, 150)));
    };
    tryOnce();
  });
}

/** Start tauri-driver with extra env for the app (SKIN_SWITCHER_CONFIG_DIR, SKIN_SWITCHER_FAULT) and open a session. */
export async function launch(world, env = {}) {
  if (!existsSync(BIN)) throw new Error(`e2e binary missing: ${BIN} (run npm run e2e:build)`);
  const driver = spawn(DRIVER, ["--port", "4444"], {
    env: { ...process.env, SKIN_SWITCHER_CONFIG_DIR: world.cfg, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await waitPort(4444);
  const browser = await remote({
    hostname: "127.0.0.1",
    port: 4444,
    logLevel: "error",
    capabilities: { "tauri:options": { application: BIN } },
  });
  return {
    browser,
    async close() {
      try {
        await browser.deleteSession();
      } catch {
        /* the app may already be gone */
      }
      driver.kill();
      await new Promise((r) => setTimeout(r, 400));
    },
  };
}

export async function waitFor(browser, selector, ms = 15000) {
  const el = await browser.$(selector);
  await el.waitForExist({ timeout: ms });
  return el;
}

export async function click(browser, selector) {
  const el = await waitFor(browser, selector);
  await el.waitForClickable({ timeout: 10000 });
  await el.click();
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
