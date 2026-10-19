import { motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { api, toFailure } from "../api";
import type { DisableMethod, LayoutMode, Loader, ReduceMotion, Settings, Snapshot } from "../api/types";
import { Field, PathField, RadioOption, Segmented } from "../components/controls";
import { HotkeyRecorder } from "../components/HotkeyRecorder";
import { LayoutPreview } from "../components/LayoutPreview";
import { Switch } from "../components/Switch";
import { riseIn, spring, staggerContainer } from "../motion";
import { useReduced } from "../lib/useReduced";
import { useApp } from "../store/app";
import "./SettingsPage.css";

/** Settings (full page, §6). Changes save instantly; "← Back" / Esc returns to the previous screen. */
export function SettingsPage() {
  const snapshot = useApp((s) => s.snapshot)!;
  const back = useApp((s) => s.back);
  const save = useApp((s) => s.saveSettings);
  const reduced = useReduced();
  const s = snapshot.settings;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "Escape" && !t.closest("input, textarea")) back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back]);

  return (
    <div className="settings">
      <header className="settings__header">
        <button className="btn" onClick={back}>
          ← Back
        </button>
        <h1 className="settings__title">Settings</h1>
        <span className="settings__saved">Changes save automatically</span>
      </header>
      <motion.div className="settings__grid" variants={staggerContainer(4, reduced)} initial="hidden" animate="show">
        <Section title="Appearance" reduced={reduced} wide>
          <Appearance s={s} snapshot={snapshot} save={save} />
        </Section>
        {/* two independent columns, so a tall Library card never leaves a hole under Mod loader */}
        <div className="settings__col">
          <Section title="Mod loader" reduced={reduced}>
            <LoaderSection s={s} save={save} />
          </Section>
          <Section title="NSFW" reduced={reduced}>
            <NsfwSection s={s} save={save} />
          </Section>
        </div>
        <div className="settings__col">
          <Section title="Library" reduced={reduced}>
            <LibrarySection s={s} snapshot={snapshot} save={save} />
          </Section>
        </div>
      </motion.div>
    </div>
  );
}

type Save = (patch: Partial<Settings>) => Promise<void>;

function Section({ title, children, reduced, wide }: { title: string; children: ReactNode; reduced: boolean; wide?: boolean }) {
  return (
    <motion.section className={`settings__section ${wide ? "is-wide" : ""}`} variants={riseIn(reduced)} aria-label={title}>
      <h2 className="settings__section-title">{title}</h2>
      {children}
    </motion.section>
  );
}

function Appearance({ s, snapshot, save }: { s: Settings; snapshot: Snapshot; save: Save }) {
  const modes: { value: LayoutMode; label: string; hint: string }[] = [
    { value: "shelves", label: "Shelves", hint: "Compact grid; skins open in a shelf under the card." },
    { value: "pages", label: "Pages", hint: "Large cover cards; each character gets its own page." },
  ];
  return (
    <div className="appearance">
      <Field label="Layout">
        <div className="layout-pick" role="radiogroup" aria-label="Layout">
          {modes.map((m) => {
            const on = s.layout === m.value;
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={on}
                className={`layout-pick__opt ${on ? "is-on" : ""}`}
                onClick={() => void save({ layout: m.value })}
              >
                {on && <motion.span layoutId="layout-ring" layoutDependency={s.layout} className="layout-pick__ring" transition={spring.snappy} />}
                <LayoutPreview mode={m.value} snapshot={snapshot} />
                <span className="layout-pick__label">{m.label}</span>
                <span className="layout-pick__hint">{m.hint}</span>
              </button>
            );
          })}
        </div>
      </Field>
      <Field label="Reduce motion" hint="On keeps crossfades but removes movement and stagger.">
        <Segmented<ReduceMotion>
          label="Reduce motion"
          value={s.reduceMotion}
          onChange={(v) => void save({ reduceMotion: v })}
          options={[
            { value: "system", label: "System" },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
      </Field>
    </div>
  );
}

function LoaderSection({ s, save }: { s: Settings; save: Save }) {
  const loaders: { value: Loader; label: string }[] = [
    { value: "xxmi", label: "XXMI" },
    { value: "3dmigoto", label: "3DMigoto (standalone)" },
  ];
  const setPath = (l: Loader, p: string) => void save({ modsPath: { ...s.modsPath, [l]: p || undefined } });
  const browse = async (l: Loader) => {
    const picked = await api.pickFolder({ title: `Choose the ${l === "xxmi" ? "XXMI" : "3DMigoto"} Mods folder`, defaultPath: s.modsPath[l] });
    if (picked) setPath(l, picked);
  };
  return (
    <div className="stack">
      {loaders.map((l) => (
        <div key={l.value} className="loader-opt">
          <RadioOption
            name="loader"
            checked={s.activeLoader === l.value}
            onSelect={() => void save({ activeLoader: l.value })}
            label={
              <>
                {l.label}
                {s.activeLoader === l.value && <span className="loader-opt__active"> · active</span>}
              </>
            }
          />
          <PathField
            label={`${l.label} Mods folder`}
            value={s.modsPath[l.value] ?? ""}
            placeholder={l.value === "xxmi" ? "%AppData%\\XXMI Launcher\\GIMI\\Mods" : "D:\\mods\\3dmigoto\\Mods"}
            onCommit={(v) => setPath(l.value, v)}
            onBrowse={() => void browse(l.value)}
          />
        </div>
      ))}
      <p className="settings__note">Switching loader re-scans that folder. Each loader keeps its own Mods path.</p>
    </div>
  );
}

function LibrarySection({ s, snapshot, save }: { s: Settings; snapshot: Snapshot; save: Save }) {
  const setSnapshot = useApp((st) => st.setSnapshot);
  const toast = useApp((st) => st.toast);
  const [scanning, setScanning] = useState(false);
  const [updating, setUpdating] = useState(false);
  const updateIndex = async () => {
    setUpdating(true);
    try {
      const snap = await api.updateHashIndex();
      setSnapshot(snap);
      toast({ kind: "success", text: `Hash index updated (${snap.hashIndex.date ?? "latest"}).` });
    } catch (e) {
      toast({ kind: "error", text: "Couldn't update the hash index.", detail: toFailure(e).message });
    } finally {
      setUpdating(false);
    }
  };
  const browse = async () => {
    const picked = await api.pickFolder({ title: "Choose the Library folder", defaultPath: s.libraryPath });
    if (picked) void save({ libraryPath: picked });
  };
  const rescan = async () => {
    setScanning(true);
    try {
      setSnapshot(await api.rescan());
      toast({ kind: "info", text: "Re-scanned the Mods folder." });
    } catch (e) {
      toast({ kind: "error", text: toFailure(e).message });
    } finally {
      setScanning(false);
    }
  };
  const open = async (kind: "mods" | "library") => {
    try {
      await api.openFolder({ kind });
    } catch (e) {
      toast({ kind: "error", text: toFailure(e).message });
    }
  };
  const methods: { value: DisableMethod; label: string; hint: string }[] = [
    { value: "move", label: "Move to Library stash", hint: "Inactive skins wait in Library/stash, same relative path. Mods stays clean." },
    { value: "prefix", label: "DISABLED prefix", hint: "Inactive skins stay in Mods, renamed DISABLED_… so 3DMigoto skips them." },
  ];
  const libs = snapshot.disk.libraries;
  return (
    <div className="stack">
      <Field
        label="Library folder"
        hint={
          snapshot.sameDrive === false ? (
            <span className="settings__warn">Library is on a different drive than Mods, so switching copies files (slower). Same drive is best.</span>
          ) : (
            "Stashed skins, extracted archives, previews and library.json live here."
          )
        }
      >
        <PathField label="Library folder" value={s.libraryPath} placeholder="D:\mods\SkinLibrary" onCommit={(v) => void save({ libraryPath: v })} onBrowse={() => void browse()} />
      </Field>
      <Field label="Disable method">
        <div>
          {methods.map((m) => (
            <RadioOption key={m.value} name="method" checked={s.disableMethod === m.value} onSelect={() => void save({ disableMethod: m.value })} label={m.label} hint={m.hint} />
          ))}
        </div>
      </Field>
      <div className="settings__actions">
        <button className="btn" onClick={() => void rescan()} disabled={scanning}>
          {scanning && <span className="spinner" aria-hidden />} Re-scan now
        </button>
        <button className="btn" onClick={() => void open("mods")}>
          Open Mods folder
        </button>
        <button className="btn btn--ghost" onClick={() => void open("library")}>
          Open Library
        </button>
      </div>
      <Field label="Libraries" hint="Global helper mods. Always on, never shown as skins.">
        {libs.length ? (
          <ul className="lib-list">
            {libs.map((l) => (
              <li key={l.path}>
                <span className="lib-list__name">{l.name}</span>
                <span className="lib-list__path">{l.path}</span>
                {l.reason === "heuristic" && <span className="tag tag--muted">guessed</span>}
              </li>
            ))}
          </ul>
        ) : (
          <div className="settings__empty">{snapshot.disk.modsExists ? "None found in the Mods folder." : "The Mods folder isn't set or doesn't exist."}</div>
        )}
      </Field>
      <div className="hash-row">
        <div>
          <div className="hash-row__title">Hash index</div>
          <div className="field__hint">
            {snapshot.hashIndex.entries
              ? `${snapshot.hashIndex.entries.toLocaleString()} hashes · snapshot ${snapshot.hashIndex.date ?? "unknown"}`
              : "Not built yet. Detection falls back to names."}
          </div>
        </div>
        <button className="btn btn--sm" onClick={() => void updateIndex()} disabled={updating}>
          {updating && <span className="spinner" aria-hidden />}
          {updating ? "Updating…" : "Update hash index"}
        </button>
      </div>
    </div>
  );
}

function NsfwSection({ s, save }: { s: Settings; save: Save }) {
  const nsfw = s.nsfw;
  return (
    <div className="stack">
      <div className="setting-row">
        <span className="setting-row__label">Reveal hotkey</span>
        <HotkeyRecorder value={nsfw.hotkey} onChange={(hotkey) => void save({ nsfw: { ...nsfw, hotkey } })} />
      </div>
      <div className="setting-row setting-row--top">
        <span className="setting-row__label">When hidden</span>
        <div>
          <RadioOption name="when-hidden" checked={nsfw.whenHidden === "stub"} onSelect={() => void save({ nsfw: { ...nsfw, whenHidden: "stub" } })} label='Small "+N" stub' hint="A dashed stub shows how many are hidden." />
          <RadioOption name="when-hidden" checked={nsfw.whenHidden === "invisible"} onSelect={() => void save({ nsfw: { ...nsfw, whenHidden: "invisible" } })} label="Fully invisible" hint="No trace until revealed." />
        </div>
      </div>
      <div className="setting-row">
        <span className="setting-row__label">Auto re-hide</span>
        <label className="setting-row__inline">
          <Switch label="Auto re-hide" checked={nsfw.autoRehide} onChange={(autoRehide) => void save({ nsfw: { ...nsfw, autoRehide } })} />
          <span className="field__hint">on minimize or after 5 minutes idle</span>
        </label>
      </div>
    </div>
  );
}
