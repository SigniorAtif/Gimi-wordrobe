import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import { useEffect } from "react";
import { AddHost } from "./components/AddHost";
import { Page, type PageKind } from "./components/Page";
import { PendingBar } from "./components/PendingBar";
import { PinPrompt } from "./components/PinPrompt";
import { Toasts } from "./components/Toasts";
import { tween } from "./motion";
import { useAutoRehide } from "./lib/useAutoRehide";
import { useMotionConfigMode, useReduced } from "./lib/useReduced";
import { useShortcuts } from "./lib/useShortcuts";
import { EntityPage } from "./screens/EntityPage";
import { Home } from "./screens/Home";
import { ImportReview } from "./screens/ImportReview";
import { SkinDetail } from "./screens/SkinDetail";
import { SettingsPage } from "./screens/SettingsPage";
import { Setup } from "./screens/Setup";
import { routeKey, useApp, type Route } from "./store/app";
import { useHome } from "./store/home";
import "./App.css";

/**
 * Animated router shell (§7, §15 M0): every screen mounts inside AnimatePresence + LayoutGroup,
 * so page transitions and shared-element morphs work from day one.
 */
export default function App() {
  const boot = useApp((s) => s.boot);
  const snapshot = useApp((s) => s.snapshot);
  const booting = useApp((s) => s.booting);
  const bootError = useApp((s) => s.bootError);
  const route = useApp((s) => s.route);
  const navDir = useApp((s) => s.navDir);
  const reduced = useReduced();
  const motionMode = useMotionConfigMode();
  const pendingShown = useHome((s) => Object.keys(s.picks).length > 0 || s.applyState.phase !== "idle");
  useShortcuts();
  useAutoRehide();

  useEffect(() => {
    void boot();
  }, [boot]);

  return (
    <MotionConfig reducedMotion={motionMode}>
      <LayoutGroup>
        <div className="app" style={{ ["--pending-offset" as string]: pendingShown ? "84px" : "0px" }}>
          <main className="app__main">
            <AnimatePresence initial={false} custom={{ dir: navDir, reduced }}>
              {snapshot ? (
                <Page key={pageId(route, snapshot.settings.layout)} id={pageId(route, snapshot.settings.layout)} kind={pageKind(route)}>
                  <Screen route={route} />
                </Page>
              ) : (
                <motion.div key="boot" className="app__boot" exit={{ opacity: 0, transition: tween.small }}>
                  {booting ? <span className="visually-hidden">Loading</span> : <BootError message={bootError} />}
                </motion.div>
              )}
            </AnimatePresence>
          </main>
          {snapshot?.configured && <PendingBar />}
          {snapshot?.configured && <AddHost />}
          <PinPrompt />
          <Toasts />
        </div>
      </LayoutGroup>
    </MotionConfig>
  );
}

function pageKind(r: Route): PageKind {
  return r.name;
}

/** Home keeps one scroll position per layout mode (SPEC §7 layout switch). */
function pageId(r: Route, layout: string): string {
  return r.name === "home" ? `home:${layout}` : routeKey(r);
}

function Screen({ route }: { route: Route }) {
  const snapshot = useApp((s) => s.snapshot)!;
  switch (route.name) {
    case "home":
      return <Home snapshot={snapshot} />;
    case "entity":
      return <EntityPage entityId={route.entityId} />;
    case "skin":
      return <SkinDetail skinId={route.skinId} />;
    case "settings":
      return <SettingsPage />;
    case "setup":
      return <Setup />;
    case "import":
      return <ImportReview />;
    default:
      return <Home snapshot={snapshot} />;
  }
}

function BootError({ message }: { message: string | null }) {
  const boot = useApp((s) => s.boot);
  return (
    <div className="app__boot-error" role="alert">
      <p>Skin Switcher couldn't start: {message}</p>
      <button className="btn" onClick={() => void boot()}>
        Try again
      </button>
    </div>
  );
}
