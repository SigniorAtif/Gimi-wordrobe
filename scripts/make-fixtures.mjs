// Writes fixtures/Mods (SPEC §14): tiny dummy mods with real hashes from the hash index, so scanning, entity
// detection, hotkey conflicts, Apply and persist backup can be tested without any real mod files.
//
//   node scripts/make-fixtures.mjs        rewrite fixtures/Mods and fixtures/d3dx_user.ini
//
// Never point this at a real Mods folder: 3DMigoto loads every .ini under Mods.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(root, "fixtures");
const MODS = join(FIX, "Mods");

const HEADER = "; fixture: dummy mod for Skin Switcher tests, not a real mod\n";

function write(rel, text) {
  const p = join(MODS, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text.replace(/\n/g, "\r\n"));
}

/** A model mod: position/blend/texcoord/ib overrides (geometry) plus key sections. */
function modelIni({ name, hashes, keys = [], persist = [], extra = "" }) {
  const consts = persist.length
    ? `[Constants]\nglobal $active\n${persist.map((p) => `global persist $${p} = 0`).join("\n")}\n\n[Present]\npost $active = 0\n\n`
    : "";
  const keyText = keys
    .map((k) => `[Key${k.label}]\n${k.gated === false ? "" : "condition = $active == 1\n"}key = ${k.key}\ntype = ${k.type ?? "cycle"}\n$${k.var ?? k.label.toLowerCase()} = 0,1\n`)
    .join("\n");
  const ov = hashes
    .map((h, i) => {
      const body = i === 0 ? `vb0 = Resource${name}Position\n$active = 1` : i === hashes.length - 1 ? `ib = Resource${name}IB\ndrawindexed = auto` : `vb1 = Resource${name}Buf${i}`;
      return `[TextureOverride${name}${i}]\nhash = ${h}\n${body}\n`;
    })
    .join("\n");
  return `${HEADER}\n${consts}${keyText}\n${ov}\n[Resource${name}Position]\ntype = Buffer\nfilename = ${name}Position.buf\n${extra}`;
}

/** A texture-only mod (weapon recolors, eye/mouth textures). */
function textureIni({ name, hashes, keys = [], persist = [] }) {
  const consts = persist.length ? `[Constants]\n${persist.map((p) => `global persist $${p} = 0`).join("\n")}\n\n` : "";
  const keyText = keys
    .map((k) => `[Key${k.label}]\n${k.gated === false ? "" : "condition = $active == 1\n"}key = ${k.key}\ntype = cycle\n$${k.var ?? k.label.toLowerCase()} = 0,1\n`)
    .join("\n");
  const ov = hashes.map((h, i) => `[TextureOverride${name}${i}]\nhash = ${h}\nthis = Resource${name}${i}\n`).join("\n");
  const res = hashes.map((_, i) => `[Resource${name}${i}]\nfilename = ${name}Diffuse${i}.dds\n`).join("\n");
  return `${HEADER}\n${consts}${keyText}\n${ov}\n${res}`;
}

rmSync(MODS, { recursive: true, force: true });
mkdirSync(MODS, { recursive: true });

// ----- libraries (SPEC §4) -----
write("ORFix.ini", `namespace = global\\ORFix\n${HEADER}\n[ShaderOverrideORFix0]\nhash = 6d514558fc6b35bb\n\n[TextureOverrideGaming]\nhash = 8b5fc47d\nrun = CommandList\\global\\ORFix\\ORFix\n`);
write("ORFixAPI.ini", `namespace = GIMI\n${HEADER}\n[CommandListSetTextures]\nrun = CommandList\\global\\ORFix\\ORFix\n`);
write("BufferValues/HealthBar.ini", `namespace=global\\HealthBar\n${HEADER}\n[Constants]\nglobal persist $health = -1\n\n[TextureOverrideIcons]\nhash = ef054414\n`);
write("TexFx-main/Main.ini", `namespace = TexFx\n${HEADER}\n[CommandListTexFx]\nx = 1\n`);
write("TexFx-main/DISABLED_Includes.ini", `namespace = TexFx\n${HEADER}`);
// heuristic library: a namespace and a hash no entity uses
write("SharedHelpers/Helpers.ini", `namespace = Helpers\\Util\n${HEADER}\n[TextureOverrideHelperProbe]\nhash = deadbeef\nrun = CommandList\\Helpers\\Util\\Probe\n`);

// ----- skipped entries -----
write(".impeccable/hook.cache.json", "{}\n");
write("disabled_x/Thing.ini", textureIni({ name: "Thing", hashes: ["8294fe98"] }));

// ----- Paimon (NPC in the index): collapses to paimon_cc116 -----
write(
  "paimon_cc116/Paimon/Paimon.ini",
  modelIni({
    name: "Paimon",
    hashes: ["1f7f0600", "e70695e0", "ce8cbdfb", "5b4cdc9c"],
    persist: ["halo", "legs", "wings"],
    keys: [
      { label: "Halo", key: "0", var: "halo" },
      { label: "Legs", key: "9", var: "legs" },
      { label: "Wings", key: "8", var: "wings" },
    ],
    extra: "\n[ResourcePaimonShadow]\nfilename = PaimonBodyShadowRamp.jpg\n",
  }),
);

// ----- Sandrone: nested face inis collapse to Face/, + outfit/ = one skin; sibling weapon is separate -----
const S = "sandrone_marionette_by_neyori";
write(`${S}/READ ME.txt`, "fixture readme\n");
write(`${S}/Face/Eyes/Face.ini`, textureIni({ name: "Eyes", hashes: ["da39adff"] }));
write(`${S}/Face/Face/Eyes/SandroneEyes.ini`, modelIni({ name: "SandroneEyes", hashes: ["9d078687", "0402a4dc", "3e8cfef4", "c07c7c7b"] }));
write(
  `${S}/Face/Face Texture/Sandrone.ini`,
  modelIni({ name: "SandroneFace", hashes: ["65a4831f", "87ecca6f"], persist: ["swapvar"], keys: [{ label: "Swap", key: "alt 7", var: "swapvar" }] }),
);
write(`${S}/Face/Mouth/Face.ini`, textureIni({ name: "Mouth", hashes: ["fbd01cd3"] }));
write(
  `${S}/outfit/Sandrone.ini`,
  modelIni({
    name: "Sandrone",
    hashes: ["65a4831f", "65475558", "f8d59976", "1aeb272b", "1bedd6d1", "c6358586", "d33c21da", "e4924b14", "73c8cae2"],
    persist: ["body", "hand", "hat", "dress", "color"],
    keys: [
      { label: "Body", key: "no_modifiers 6", var: "body" },
      { label: "Hand", key: "no_modifiers 7", var: "hand" },
      { label: "Hat", key: "no_modifiers 8", var: "hat" },
      { label: "Dress", key: "no_modifiers 9", var: "dress" },
      { label: "Color", key: "alt 8", var: "color" },
    ],
  }),
);
write(
  `${S}/A Teaspoon of Transcendence/ATeaspoonOfTranscendence.ini`,
  textureIni({ name: "ATeaspoonOfTranscendence", hashes: ["13480caf"], persist: ["color"], keys: [{ label: "Color", key: "alt 9", var: "color" }] }),
);

// ----- Furina container: two alternatives (same body hashes), a DISABLED one, and a desktop.ini -----
const FURINA = ["8294fe98", "d8c43862", "a327ea5e", "045e580b"];
write("Furina/Remembrance/Furina.ini", modelIni({ name: "Furina", hashes: FURINA, persist: ["hat"], keys: [{ label: "Hat", key: "6", var: "hat" }] }));
write("Furina/Remembrance/desktop.ini", "[.ShellClassInfo]\r\nIconResource=C:\\Windows\\System32\\imageres.dll,-3\r\n");
write("Furina/Casual/Furina.ini", modelIni({ name: "FurinaCasual", hashes: FURINA, keys: [{ label: "Coat", key: "7" }] }));
write("Furina/DISABLED_Old/Furina.ini", modelIni({ name: "FurinaOld", hashes: FURINA }));

// ----- Kazuha: merged pack with DISABLED variant folders and a DISABLED sub-mod ini -----
const KAZUHA = ["7c0c47b3", "28a1fab0", "5f7534b6", "356cdbde"];
write(
  "Kazuha/Multi/merged.ini",
  modelIni({
    name: "Kazuha",
    hashes: KAZUHA,
    persist: ["hair", "hand", "color"],
    keys: [
      { label: "Hair", key: "6", var: "hair" },
      { label: "Hand", key: "7", var: "hand" },
      { label: "Color", key: "alt 8", var: "color" },
    ],
  }),
);
write("Kazuha/Multi/DISABLED_01 Normal/Kazuha.ini", modelIni({ name: "KazuhaNormal", hashes: KAZUHA }));
write("Kazuha/Multi/DISABLED 02 Ponytail/Kazuha.ini", modelIni({ name: "KazuhaPony", hashes: KAZUHA }));
write("Kazuha/Multi/Toukabou/DISABLEDtoukabou.ini", textureIni({ name: "Toukabou", hashes: ["df022de9"] }));

// ----- Mona: an ungated key (red conflict with every 6) -----
write("Mona/Starry Witch/MonaCN.ini", modelIni({ name: "MonaCN", hashes: ["515f3ce6", "bad2731b", "e543af5d", "d5ad8084"], keys: [{ label: "Hat", key: "6", gated: false, type: "toggle" }] }));

// ----- Varesa: multi-root skin (Face + Outfit) under a container, DISABLED file inside -----
write("Varesa/Face/Face Textures/Varesa.ini", textureIni({ name: "VaresaFace", hashes: ["47590010"], keys: [{ label: "Swap", key: "alt 4" }] }));
write("Varesa/Face/Eyes/FaceTutorial.ini", textureIni({ name: "VaresaEyes", hashes: ["a1b2c3d4"] }));
write("Varesa/Outfit/Varesa.ini", modelIni({ name: "Varesa", hashes: ["9784dbe3", "ef26783e", "0fa7f23f", "488fceb4"], persist: ["jacket"], keys: [{ label: "Jacket", key: "no_modifiers 4", var: "jacket" }] }));
write("Varesa/Outfit/Nightsoul.ini", textureIni({ name: "Nightsoul", hashes: ["edae63e5"] }));
write("Varesa/Outfit/DISABLEDVaresa.ini", modelIni({ name: "VaresaOld", hashes: ["9784dbe3"] }));

// ----- Odette: not in the hash index (folder-name guess) -----
write("Odette/Black Swan/Odette.ini", modelIni({ name: "Odette", hashes: ["0dee0001", "0dee0002", "0dee0003"] }));

// ----- a weapon with a key that clashes with characters' 6 -----
write("Tome of the Eternal Flow/Blood Flow/TomeOfTheEternalFlow.ini", textureIni({ name: "Tome", hashes: ["788a5c69"], keys: [{ label: "Glow", key: "alt 6" }] }));

// ----- stray archives in the Mods root (tiny zips) -----
for (const z of ["paimon_cc116.zip", "sandrone_marionette_by_neyori.zip"]) {
  const tmp = join(FIX, ".tmp-zip");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "readme.txt"), "fixture archive\n");
  execFileSync("bsdtar", ["--format", "zip", "-cf", join(MODS, z), "-C", tmp, "readme.txt"]);
  rmSync(tmp, { recursive: true, force: true });
}

// ----- d3dx_user.ini next to Mods (persist backup/restore, SPEC §3) -----
writeFileSync(
  join(FIX, "d3dx_user.ini"),
  [
    "; AUTOMATICALLY GENERATED FILE - DO NOT EDIT",
    ";",
    "[Constants]",
    "$version = 7",
    "$\\global\\healthbar\\health = -1",
    `$\\mods\\${S}\\a teaspoon of transcendence\\ateaspoonoftranscendence.ini\\color = 0`,
    `$\\mods\\${S}\\face\\face texture\\sandrone.ini\\swapvar = 0`,
    `$\\mods\\${S}\\outfit\\sandrone.ini\\body = 2`,
    `$\\mods\\${S}\\outfit\\sandrone.ini\\hand = 0`,
    `$\\mods\\${S}\\outfit\\sandrone.ini\\hat = 2`,
    `$\\mods\\${S}\\outfit\\sandrone.ini\\dress = 2`,
    `$\\mods\\${S}\\outfit\\sandrone.ini\\color = 1`,
    "$\\mods\\furina\\remembrance\\furina.ini\\hat = 1",
    "$\\mods\\paimon_cc116\\paimon\\paimon.ini\\wings = 1",
    "",
  ].join("\r\n"),
);

console.log(`fixtures written to ${MODS}`);
