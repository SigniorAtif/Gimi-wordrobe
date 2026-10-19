// Builds src-tauri/resources/hash_index.json from SilentNightSound/GI-Model-Importer-Assets (SPEC §5).
//
// The upstream data is GPL-3.0 and this repo is public without a licence, so the generated file is
// gitignored and rebuilt here instead of committed. Runs as `predev` / `prebuild`:
//   node scripts/build-hash-index.mjs            skip if the file is under 7 days old
//   node scripts/build-hash-index.mjs --force    always refetch
//   node scripts/build-hash-index.mjs --strict   fail when it can't produce a real index (release builds)
//   node scripts/build-hash-index.mjs --out <path>
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "SilentNightSound/GI-Model-Importer-Assets";
const BRANCH = "main";
const MAX_AGE_DAYS = 7;
const CONCURRENCY = 12;

const args = process.argv.slice(2);
const force = args.includes("--force");
const strict = args.includes("--strict");
const outIdx = args.indexOf("--out");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = outIdx >= 0 ? resolve(args[outIdx + 1]) : resolve(root, "src-tauri/resources/hash_index.json");

const GROUPS = {
  PlayerCharacterData: "character",
  WeaponData: "weapon",
  NPCData: "npc",
  EnemyData: "enemy",
  MiscellaneousData: "misc",
  SkillData: "skill",
};

// Folder names that humanise badly. Our own spellings, not upstream data.
const NAME_OVERRIDES = {
  TomeofEternalFlow: "Tome of the Eternal Flow",
  KaedeharaKazuha: "Kazuha",
  HuTao: "Hu Tao",
  YaeMiko: "Yae Miko",
  RaidenShogun: "Raiden Shogun",
  KamisatoAyaka: "Kamisato Ayaka",
  KamisatoAyato: "Kamisato Ayato",
  KujouSara: "Kujou Sara",
  KukiShinobu: "Kuki Shinobu",
  ShikanoinHeizou: "Shikanoin Heizou",
  YunJin: "Yun Jin",
  XianYun: "Xianyun",
};

const COMPONENT_FIELDS = ["ib", "position_vb", "blend_vb", "texcoord_vb", "draw_vb"];

function log(msg) {
  console.log(`hash-index: ${msg}`);
}

function ageDays(p) {
  return (Date.now() - statSync(p).mtimeMs) / 86_400_000;
}

function readExisting() {
  try {
    return JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    return null;
  }
}

function writePlaceholder(reason) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ version: 1, source: REPO, commit: null, date: null, entities: [], hashes: {} }));
  log(`wrote an empty placeholder (${reason}); entity detection falls back to names`);
}

async function getJson(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "skin-switcher-build", Accept: "application/json" } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      return await res.json();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last;
}

export function humanize(key) {
  if (NAME_OVERRIDES[key]) return NAME_OVERRIDES[key];
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .split(" ")
    .map((w) => w.replace(/^(.{3,}?)of$/, "$1 of"))
    .join(" ")
    .trim();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function build() {
  const existing = existsSync(OUT) ? readExisting() : null;
  if (!force && existing?.commit && ageDays(OUT) < MAX_AGE_DAYS) {
    log(`fresh (${existing.date}, ${Object.keys(existing.hashes).length} hashes), skipped`);
    return;
  }

  const commit = await getJson(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`);
  const sha = commit.sha;
  const date = (commit.commit?.committer?.date ?? "").slice(0, 10) || null;
  if (!force && existing?.commit === sha) {
    const now = new Date();
    utimesSync(OUT, now, now);
    log(`upstream unchanged (${date}), kept`);
    return;
  }

  const tree = await getJson(`https://api.github.com/repos/${REPO}/git/trees/${sha}?recursive=1`);
  const paths = tree.tree.map((t) => t.path).filter((p) => p.endsWith("/hash.json") && GROUPS[p.split("/")[0]]);
  log(`fetching ${paths.length} hash.json files at ${sha.slice(0, 7)} (${date})`);

  const files = await mapLimit(paths, CONCURRENCY, (p) =>
    getJson(`https://raw.githubusercontent.com/${REPO}/${sha}/${p.split("/").map(encodeURIComponent).join("/")}`).catch(() => null),
  );
  const missing = paths.filter((_, i) => !files[i]);
  if (missing.length) {
    // all or nothing: a partial index stamped with this commit would hide entities until upstream changes
    throw new Error(`${missing.length} of ${paths.length} hash.json files failed to download (${missing.slice(0, 3).join(", ")}...)`);
  }

  const charKeys = new Set(paths.filter((p) => p.startsWith("PlayerCharacterData/")).map((p) => p.split("/").at(-2)));
  const entities = [];
  const hashes = {};
  const add = (hash, hit) => {
    const h = String(hash || "").trim().toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(h)) return; // 16-hex root_vs shader hashes are shared across models
    (hashes[h] ??= []).push(hit);
  };

  paths.forEach((p, i) => {
    const data = files[i];
    if (!data) return;
    const parts = p.split("/");
    const key = parts.at(-2);
    const group = GROUPS[parts[0]];
    // Outfit variants (FischlHighness) belong to their base character.
    let base = null;
    if (group === "character") {
      for (const c of charKeys) {
        if (c !== key && key.startsWith(c) && /^[A-Z]/.test(key.slice(c.length))) {
          if (!base || c.length > base.length) base = c;
        }
      }
    }
    if (group === "npc" && key !== "Paimon" && key.startsWith("Paimon")) base = "Paimon";
    const idx = entities.length;
    entities.push({ key, name: humanize(key), group, base, path: parts.slice(0, -1).join("/") });
    const comps = Array.isArray(data) ? data : Object.values(data);
    for (const c of comps) {
      if (!c || typeof c !== "object") continue;
      const part = String(c.component_name ?? "");
      for (const f of COMPONENT_FIELDS) add(c[f], [idx, f, part]);
      for (const set of c.texture_hashes ?? []) {
        for (const t of Array.isArray(set) ? set : []) {
          if (Array.isArray(t) && t.length >= 3) add(t[2], [idx, `texture:${t[0]}`, part]);
        }
      }
    }
  });

  if (!entities.length) throw new Error("no hash.json files could be read");
  mkdirSync(dirname(OUT), { recursive: true });
  const out = { version: 1, source: REPO, license: "GPL-3.0 upstream data; generated, never committed", commit: sha, date, entities, hashes };
  writeFileSync(OUT, JSON.stringify(out));
  log(`wrote ${entities.length} entities, ${Object.keys(hashes).length} hashes -> ${OUT}`);
}

build().catch((e) => {
  const existing = existsSync(OUT) ? readExisting() : null;
  if (existing?.commit) {
    log(`update failed (${e.message}); keeping the existing index from ${existing.date}`);
    return;
  }
  if (strict) {
    console.error(`hash-index: failed and no previous index exists: ${e.message}`);
    process.exit(1);
  }
  writePlaceholder(e.message);
});
