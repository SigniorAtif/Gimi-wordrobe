// Builds a debug app binary with the frontend embedded and copies it aside, so `tauri dev` can't overwrite it.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const target = process.env.CARGO_TARGET_DIR ?? join(process.cwd(), "src-tauri/target");
execFileSync("npm", ["run", "tauri", "--", "build", "--debug", "--no-bundle"], { stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: target } });
const out = join(homedir(), ".cache/skin-switcher-e2e");
mkdirSync(out, { recursive: true });
copyFileSync(join(target, "debug/skin-switcher"), join(out, "skin-switcher-e2e"));
console.log(`e2e binary: ${join(out, "skin-switcher-e2e")}`);
