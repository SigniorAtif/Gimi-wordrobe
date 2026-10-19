import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import { useEffect } from "react";
import { Page, type PageKind } from "./components/Page";
import { Toasts } from "./components/Toasts";
import { tween } from "./motion";
import { useMotionConfigMode, useReduced } from "./lib/useReduced";
import { Home } from "./screens/Home";
import { SettingsPage } from "./screens/SettingsPage";
import { Setup } from "./screens/Setup";
import { routeKey, useApp, type Route } from "./store/app";
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

  useEffect(() => {
    void boot();
  }, [boot]);

  return (
    <MotionConfig reducedMotion={motionMode}>
      <LayoutGroup>
        <div className="app">
          <main className="app__main">
            <AnimatePresence initial={false} custom={{ dir: navDir, reduced }}>
              {snapshot ? (
                <Page key={routeKey(route)} id={routeKey(route)} kind={pageKind(route)}>
                  <Screen route={route} />
                </Page>
              ) : (
                <motion.div key="boot" className="app__boot" exit={{ opacity: 0, transition: tween.small }}>
                  {booting ? <span className="visually-hidden">Loading</span> : <BootError message={bootError} />}
                </motion.div>
              )}
            </AnimatePresence>
          </main>
          <Toasts />
        </div>
      </LayoutGroup>
    </MotionConfig>
  );
}

function pageKind(r: Route): PageKind {
  return r.name;
}

function Screen({ route }: { route: Route }) {
  const snapshot = useApp((s) => s.snapshot)!;
  switch (route.name) {
    case "home":
      return <Home snapshot={snapshot} />;
    case "settings":
      return <SettingsPage />;
    case "setup":
      return <Setup />;
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
