import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { api, toFailure } from "../api";
import type { FixerScript, Loader } from "../api/types";
import { Field, PathField, RadioOption } from "../components/controls";
import { FixerScriptList, RecommendedFixers } from "../components/FixerScripts";
import { riseIn, staggerContainer } from "../motion";
import { useReduced } from "../lib/useReduced";
import { useApp, wantsImport } from "../store/app";
import "./Setup.css";

/** First-run setup (§5 step 1): loader, Mods folder (pre-filled on Windows) and a Library path. */
export function Setup() {
  const snapshot = useApp((s) => s.snapshot)!;
  const setSnapshot = useApp((s) => s.setSnapshot);
  const replace = useApp((s) => s.replace);
  const reduced = useReduced();
  const [loader, setLoader] = useState<Loader>(snapshot.settings.activeLoader);
  const [mods, setMods] = useState<Record<Loader, string>>({
    xxmi: snapshot.settings.modsPath.xxmi ?? "",
    "3dmigoto": snapshot.settings.modsPath["3dmigoto"] ?? "",
  });
  const [library, setLibrary] = useState(snapshot.settings.libraryPath);
  const [fixers, setFixers] = useState<FixerScript[]>(snapshot.settings.fixerScripts ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The form appears once the pre-fill is known, so defaults never overwrite something the user typed.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .firstRunDefaults()
      .then((d) => {
        if (!live) return;
        setMods((m) => ({ xxmi: m.xxmi || d.modsXxmi || "", "3dmigoto": m["3dmigoto"] || d.mods3dmigoto || "" }));
        setLibrary((l) => l || d.library || "");
        if (d.loader) setLoader(d.loader);
      })
      .catch(() => {})
      .finally(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);

  const browse = async (kind: "mods" | "library") => {
    const picked = await api.pickFolder({
      title: kind === "mods" ? "Choose the Mods folder" : "Choose a Library folder",
      defaultPath: kind === "mods" ? mods[loader] : library,
    });
    if (!picked) return;
    if (kind === "mods") setMods((m) => ({ ...m, [loader]: picked }));
    else setLibrary(picked);
  };

  const finish = async () => {
    setError(null);
    if (!mods[loader].trim()) return setError("Choose the Mods folder your loader uses.");
    if (!library.trim()) return setError("Choose a Library folder.");
    setBusy(true);
    try {
      const next = {
        ...snapshot.settings,
        activeLoader: loader,
        modsPath: { xxmi: mods.xxmi || undefined, "3dmigoto": mods["3dmigoto"] || undefined },
        libraryPath: library.trim(),
        fixerScripts: fixers,
      };
      const snap = await api.saveSettings(next);
      setSnapshot(snap);
      replace(wantsImport(snap) ? { name: "import" } : { name: "home" });
    } catch (e) {
      setError(toFailure(e).message);
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return <div className="setup" />;

  return (
    <div className="setup">
      <motion.div className="setup__panel" variants={staggerContainer(6, reduced, 0.05)} initial="hidden" animate="show">
        <motion.div variants={riseIn(reduced)}>
          <h1 className="setup__title">Set up Skin Switcher</h1>
          <p className="setup__lead">Point it at the Mods folder your loader reads. Nothing is moved until you confirm.</p>
        </motion.div>
        <motion.div variants={riseIn(reduced)}>
          <Field label="Mod loader">
            <div className="setup__loaders">
              <RadioOption name="setup-loader" checked={loader === "xxmi"} onSelect={() => setLoader("xxmi")} label="XXMI" hint="XXMI Launcher (recommended upstream)" />
              <RadioOption name="setup-loader" checked={loader === "3dmigoto"} onSelect={() => setLoader("3dmigoto")} label="3DMigoto (standalone)" hint="GIMI with 3DMigoto Loader.exe" />
            </div>
          </Field>
        </motion.div>
        <motion.div variants={riseIn(reduced)}>
          <Field label="Mods folder">
            <PathField
              label="Mods folder"
              value={mods[loader]}
              placeholder={loader === "xxmi" ? "%AppData%\\XXMI Launcher\\GIMI\\Mods" : "D:\\mods\\3dmigoto\\Mods"}
              onCommit={(v) => setMods((m) => ({ ...m, [loader]: v }))}
              onBrowse={() => void browse("mods")}
            />
          </Field>
        </motion.div>
        <motion.div variants={riseIn(reduced)}>
          <Field label="Library" hint="Keep it on the same drive as Mods so switching skins is instant. Never inside Mods.">
            <PathField label="Library folder" value={library} placeholder="D:\mods\SkinLibrary" onCommit={setLibrary} onBrowse={() => void browse("library")} />
          </Field>
        </motion.div>
        <motion.div variants={riseIn(reduced)}>
          <Field label="Fixer scripts (optional)" hint="Tools that repair older mods (green or distorted characters). Every skin you add goes through them first. You can change this later in Settings.">
            <div className="setup__fixers">
              <RecommendedFixers />
              <FixerScriptList scripts={fixers} onChange={setFixers} />
            </div>
          </Field>
        </motion.div>
        <motion.div variants={riseIn(reduced)} className="setup__footer">
          {error ? (
            <span className="setup__error" role="alert">
              {error}
            </span>
          ) : (
            <span />
          )}
          <button className="btn btn--primary" onClick={() => void finish()} disabled={busy}>
            {busy && <span className="spinner" aria-hidden />}
            Continue
          </button>
        </motion.div>
      </motion.div>
    </div>
  );
}
