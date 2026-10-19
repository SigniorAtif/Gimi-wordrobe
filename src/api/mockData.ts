// Fixture data for the browser test harness (VITE_MOCK=1). Mirrors the SPEC §5 roster.
// Covers are generated SVG art: no real mod images ever ship in this repo.
import { parseKey } from "../lib/hotkeys";
import type { Category, Entity, Hotkey, Library, Settings, Skin } from "./types";

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Abstract 3:4 cover art, deterministic per seed. */
export function coverArt(seed: string, variant = 0): string {
  const h = hashStr(seed + variant);
  const hue = h % 360;
  const hue2 = (hue + 40 + (h >> 9) % 80) % 360;
  const cx = 30 + ((h >> 3) % 40);
  const cy = 20 + ((h >> 7) % 35);
  const r = 38 + ((h >> 11) % 22);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400">
<defs>
<radialGradient id="a" cx="${cx}%" cy="${cy}%" r="${r}%"><stop offset="0" stop-color="oklch(0.78 0.11 ${hue})"/><stop offset="1" stop-color="oklch(0.32 0.08 ${hue})" stop-opacity="0"/></radialGradient>
<linearGradient id="b" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="oklch(0.36 0.07 ${hue2})"/><stop offset="1" stop-color="oklch(0.16 0.03 ${hue2})"/></linearGradient>
</defs>
<rect width="300" height="400" fill="url(#b)"/>
<rect width="300" height="400" fill="url(#a)"/>
<ellipse cx="150" cy="${250 + (h % 30)}" rx="${70 + (h % 25)}" ry="150" fill="oklch(0.2 0.04 ${hue2})" opacity="0.55"/>
<circle cx="150" cy="${120 + (h % 20)}" r="${42 + (h % 10)}" fill="oklch(0.24 0.05 ${hue2})" opacity="0.6"/>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function portraitArt(seed: string): string {
  const h = hashStr(seed);
  const hue = h % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<defs><radialGradient id="p" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="oklch(0.72 0.1 ${hue})"/><stop offset="1" stop-color="oklch(0.28 0.06 ${hue})"/></radialGradient></defs>
<rect width="100" height="100" fill="url(#p)"/>
<circle cx="50" cy="40" r="18" fill="oklch(0.22 0.04 ${hue})" opacity="0.5"/>
<ellipse cx="50" cy="92" rx="34" ry="26" fill="oklch(0.22 0.04 ${hue})" opacity="0.5"/>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function hk(keys: string, label: string, kind: Hotkey["kind"], gated: boolean, iniFile: string): Hotkey {
  const parsed = parseKey(keys);
  return { keys, label, kind, gated, section: `Key${label.replace(/\W/g, "")}`, iniFile, parsed: parsed ? [parsed] : [] };
}

interface SkinSeed {
  name: string;
  author?: string;
  folders: string[];
  nsfw?: boolean;
  active?: boolean;
  previews?: number;
  hotkeys?: Hotkey[];
  gb?: string;
  version?: string;
  archive?: string;
  notes?: string;
}

interface EntitySeed {
  name: string;
  category: Category;
  parent?: string;
  aliases?: string[];
  skins: SkinSeed[];
}

const ROSTER: EntitySeed[] = [
  { name: "Alyosha", category: "character", skins: [{ name: "Frostbound Hunt", author: "Kaichu", folders: ["Alyosha/Frostbound Hunt"], active: true, previews: 2, archive: "alyosha_-_frostbound_hunt_ae58f.zip" }] },
  {
    name: "Arlecchino",
    category: "character",
    skins: [
      { name: "Elegant", author: "Lumi", folders: ["Arlecchino/Elegant"], active: true, previews: 3, hotkeys: [hk("no_modifiers 5", "Coat", "toggle", true, "Arlecchino.ini")] },
      { name: "Magical", author: "Ryo", folders: ["Arlecchino/Magical"], previews: 2 },
    ],
  },
  { name: "Bennett", category: "character", aliases: ["Benny"], skins: [{ name: "Beach Day", author: "Sora", folders: ["Bennett/Beach Day"], active: true, previews: 1 }] },
  { name: "Charlotte", category: "character", skins: [{ name: "Bear", author: "Mimi", folders: ["Charlotte/Bear"], active: true, previews: 2, hotkeys: [hk("no_modifiers 3", "Variant", "cycle", true, "merged.ini")] }] },
  { name: "Diluc", category: "character", skins: [{ name: "In White", author: "Ashe", folders: ["Diluc/In White"], active: true, previews: 4 }] },
  { name: "Fischl", category: "character", skins: [{ name: "Hexenzirkel", author: "Nyx", folders: ["Fischl/Hexenzirkel"], active: true, previews: 2 }] },
  {
    name: "Furina",
    category: "character",
    skins: [
      { name: "Remembrance", author: "kaichume", folders: ["Furina/Remembrance"], active: true, previews: 3, version: "6.1", gb: "https://gamebanana.com/mods/500001", hotkeys: [hk("6", "Hat", "toggle", true, "Furina.ini"), hk("no_modifiers 7", "Gloves", "toggle", true, "Furina.ini")] },
      { name: "Casual", author: "Ren", folders: ["Furina/Casual"], previews: 1 },
    ],
  },
  { name: "Ganyu", category: "character", skins: [] },
  {
    name: "Kazuha",
    category: "character",
    skins: [
      {
        name: "Multi",
        author: "Hoshi",
        folders: ["Kazuha/Multi"],
        active: true,
        previews: 5,
        version: "1.0",
        hotkeys: [hk("6", "Hair", "cycle", true, "merged.ini"), hk("7", "Hand", "toggle", true, "merged.ini"), hk("alt 8", "Color", "cycle", true, "merged.ini")],
      },
    ],
  },
  {
    name: "Mona",
    category: "character",
    skins: [
      { name: "Starry Witch", author: "Vela", folders: ["Mona/Starry Witch"], active: true, previews: 2 },
      { name: "Divine Astrologist", author: "Vela", folders: ["Mona/Divine Astrologist"], previews: 3 },
    ],
  },
  {
    name: "Neuvillette",
    category: "character",
    aliases: ["Neuvilette"],
    skins: [
      { name: "Wedding", author: "annplan", folders: ["Neuvillette/Wedding"], active: true, previews: 2 },
      { name: "Vampire", author: "Dusk", folders: ["Neuvillette/Vampire"], previews: 3 },
    ],
  },
  { name: "Odette", category: "character", skins: [{ name: "Black Swan", author: "Lune", folders: ["Odette/Black Swan"], active: true, previews: 2 }] },
  {
    name: "Varesa",
    category: "character",
    aliases: ["Veresa"],
    skins: [
      { name: "By Neyori", author: "Neyori", folders: ["Varesa/By Neyori/Face", "Varesa/By Neyori/Outfit"], active: true, previews: 3, hotkeys: [hk("no_modifiers 4", "Jacket", "toggle", true, "Outfit/Varesa.ini"), hk("alt 4", "Nightsoul", "toggle", true, "Outfit/Nightsoul.ini")] },
      { name: "Culottée à mort", author: "lewdmods", folders: ["Varesa/Culottee a mort"], nsfw: true, previews: 2 },
      { name: "Nude", author: "RenKamui", folders: ["Varesa/Nude"], nsfw: true, previews: 0 },
      { name: "Cow Girl", author: "weebovz", folders: ["Varesa/Cow Girl"], nsfw: true, previews: 1 },
    ],
  },
  {
    name: "Yae Miko",
    category: "character",
    aliases: ["YaeMiko", "Miko"],
    skins: [
      { name: "Sakura Kimono", author: "Hana", folders: ["Yae Miko/Sakura Kimono"], active: true, previews: 2 },
      { name: "Lunar Grace", author: "Hana", folders: ["Yae Miko/Lunar Grace"], previews: 2 },
    ],
  },
  {
    name: "Paimon",
    category: "character",
    skins: [
      {
        name: "CC116",
        author: "cc116",
        folders: ["paimon_cc116"],
        active: true,
        previews: 1,
        hotkeys: [hk("0", "Halo", "cycle", true, "Paimon/Paimon.ini"), hk("8", "Wings", "cycle", true, "Paimon/Paimon.ini"), hk("9", "Legs", "cycle", true, "Paimon/Paimon.ini")],
      },
    ],
  },
  {
    name: "Sandrone",
    category: "character",
    skins: [
      {
        name: "Marionette",
        author: "Neyori",
        folders: ["sandrone_marionette_by_neyori/Face", "sandrone_marionette_by_neyori/outfit"],
        active: true,
        previews: 3,
        hotkeys: [
          hk("no_modifiers 6", "Body", "cycle", true, "outfit/Sandrone.ini"),
          hk("no_modifiers 7", "Hand", "cycle", true, "outfit/Sandrone.ini"),
          hk("no_modifiers 8", "Hat", "cycle", true, "outfit/Sandrone.ini"),
          hk("no_modifiers 9", "Dress", "cycle", true, "outfit/Sandrone.ini"),
          hk("alt 8", "Color", "cycle", true, "outfit/Sandrone.ini"),
          hk("alt 7", "Swap", "cycle", true, "Face/Face Texture/Sandrone.ini"),
        ],
      },
    ],
  },
  {
    name: "Tome of the Eternal Flow",
    category: "weapon",
    skins: [
      { name: "Blood Flow", author: "Crimson", folders: ["Tome of the Eternal Flow/Blood Flow"], active: true, previews: 1 },
      { name: "Gold Recolor", author: "annplan", folders: ["Tome of the Eternal Flow/Gold Recolor"], previews: 0 },
    ],
  },
  { name: "Skyward Blade", category: "weapon", skins: [{ name: "Bennett Beach Day", author: "Sora", folders: ["Skyward Blade/Bennett Beach Day"], active: true, previews: 0 }] },
  {
    name: "A Teaspoon of Transcendence",
    category: "weapon",
    skins: [{ name: "Marionette", author: "Neyori", folders: ["sandrone_marionette_by_neyori/A Teaspoon of Transcendence"], active: true, previews: 1, hotkeys: [hk("alt 9", "Color", "cycle", true, "ATeaspoonOfTranscendence.ini")] }],
  },
  { name: "Oz", category: "extra", parent: "Fischl", skins: [{ name: "Hexenzirkel Oz", author: "Nyx", folders: ["Oz/Hexenzirkel Oz"], active: true, previews: 1 }] },
];

export interface MockWorld {
  library: Library;
  /** skinIds whose folders are currently in Mods (active). Reassigned on rollback. */
  active: Set<string>;
  images: Map<string, string>; // preview file path -> data URL
}

export function buildMockWorld(): MockWorld {
  const entities: Entity[] = [];
  const skins: Skin[] = [];
  const active = new Set<string>();
  const images = new Map<string, string>();
  const idByName = new Map(ROSTER.map((e) => [e.name, slug(e.name)]));
  let day = 0;
  for (const e of ROSTER) {
    const id = slug(e.name);
    const ent: Entity = { id, name: e.name, category: e.category, skinIds: [], aliases: e.aliases };
    if (e.parent) ent.parentId = idByName.get(e.parent);
    ent.portrait = `portraits/${id}.svg`;
    images.set(ent.portrait, portraitArt(e.name));
    for (const s of e.skins) {
      const sid = `${id}--${slug(s.name)}`;
      const previews = Array.from({ length: s.previews ?? 0 }, (_, i) => {
        const file = `previews/${sid}/${i + 1}.svg`;
        images.set(file, coverArt(sid, i));
        return { file, source: (i % 2 === 0 ? "gamebanana" : "archive") as "gamebanana" | "archive" };
      });
      day += 1;
      skins.push({
        id: sid,
        entityId: id,
        name: s.name,
        author: s.author,
        version: s.version,
        folders: s.folders,
        nsfw: !!s.nsfw,
        gameBananaUrl: s.gb,
        sourceArchive: s.archive,
        previews,
        hotkeys: s.hotkeys ?? [],
        hashes: [],
        notes: s.notes,
        addedAt: new Date(Date.UTC(2026, 8, 1 + day)).toISOString(),
      });
      ent.skinIds.push(sid);
      if (s.active) active.add(sid);
    }
    entities.push(ent);
  }
  return { library: { version: 1, entities, skins }, active, images };
}

export const MOCK_SETTINGS: Settings = {
  activeLoader: "3dmigoto",
  modsPath: { "3dmigoto": "D:\\mods\\3dmigoto\\Mods", xxmi: "C:\\Users\\you\\AppData\\Roaming\\XXMI Launcher\\GIMI\\Mods" },
  libraryPath: "D:\\mods\\SkinLibrary",
  disableMethod: "move",
  layout: "shelves",
  reduceMotion: "system",
  nsfw: { hotkey: "Ctrl+H", whenHidden: "stub", autoRehide: true },
};

export const MOCK_LIBRARIES = [
  { path: "ORFix.ini", name: "ORFix", reason: "known" as const },
  { path: "ORFixAPI.ini", name: "ORFixAPI", reason: "known" as const },
  { path: "BufferValues/HealthBar.ini", name: "HealthBar", reason: "known" as const },
  { path: "TexFx-main", name: "TexFx", reason: "known" as const },
];
