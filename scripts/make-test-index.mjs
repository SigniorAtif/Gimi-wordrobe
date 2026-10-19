// Rebuilds fixtures/hash_index.test.json: only the hashes the fixture inis quote (fixtures/Mods and the sample
// archives), looked up in the generated full index. SPEC §5 lets fixtures quote a handful of real hashes; the full
// GPL-3.0 index itself is never committed.
//   npm run hash-index && node scripts/make-test-index.mjs
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const full = JSON.parse(readFileSync(join(root, "src-tauri/resources/hash_index.json"), "utf8"));
const used = new Set();
const grab = (text) => {
  for (const m of text.matchAll(/^\s*hash\s*=\s*([0-9a-fA-F]{8})\s*$/gm)) used.add(m[1].toLowerCase());
};
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.toLowerCase().endsWith(".ini")) grab(readFileSync(p, "utf8"));
  }
})(join(root, "fixtures/Mods"));
const arch = join(root, "fixtures/archives");
for (const n of readdirSync(arch)) {
  if (n.startsWith("evil")) continue;
  grab(execFileSync("bsdtar", ["-xOf", join(arch, n), "--include", "*.ini"], { encoding: "utf8" }));
}
const keep = new Map();
const entities = [];
const hashes = {};
const ensure = (i) => {
  if (!keep.has(i)) {
    keep.set(i, entities.length);
    entities.push({ ...full.entities[i] });
  }
  return keep.get(i);
};
for (const h of [...used].sort()) for (const [i, c, p] of full.hashes[h] ?? []) (hashes[h] ??= []).push([ensure(i), c, p]);
for (const e of entities) if (e.base) ensure(full.entities.findIndex((x) => x.key === e.base));
ensure(full.entities.findIndex((e) => e.key === "Oz" && e.group === "npc"));
writeFileSync(
  join(root, "fixtures/hash_index.test.json"),
  JSON.stringify({ version: 1, source: "hashes quoted by the fixture inis (see fixtures/); not the full index", commit: "test", date: full.date, entities, hashes }, null, 1),
);
console.log(`test index: ${entities.length} entities, ${Object.keys(hashes).length} hashes`);
