import { useApp } from "../store/app";
import "./SettingsPage.css";

/** Settings (full page). Sections are filled in by the Settings milestone. */
export function SettingsPage() {
  const back = useApp((s) => s.back);
  return (
    <div className="settings">
      <header className="settings__header">
        <button className="btn" onClick={back}>
          ← Back
        </button>
        <h1 className="settings__title">Settings</h1>
      </header>
    </div>
  );
}
