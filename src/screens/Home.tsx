import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { Category, Snapshot } from "../api/types";
import { AnimatedNumber } from "../components/AnimatedNumber";
import { EntityCard } from "../components/EntityCard";
import { MenuItem, Popover, type Anchor } from "../components/Popover";
import { Shelf } from "../components/Shelf";
import { Toolbar } from "../components/Toolbar";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  entityView,
  matchesChip,
  matchesQuery,
  sortEntities,
  type EntityView,
} from "../lib/derive";
import { useColumns } from "../lib/useColumns";
import { useReduced } from "../lib/useReduced";
import { riseIn, spring, staggerContainer, tween } from "../motion";
import { useApp } from "../store/app";
import { useHome } from "../store/home";
import "./Home.css";

/** Mode C home (C1 + C2): one scrolling page of sections; a card's shelf opens under its row (SPEC §6). */
export function Home({ snapshot }: { snapshot: Snapshot }) {
  const reduced = useReduced();
  const replay = useApp((s) => s.navDir) === 1;
  const picks = useHome((s) => s.picks);
  const query = useHome((s) => s.query);
  const chip = useHome((s) => s.chip);
  const nsfwVisible = useHome((s) => s.nsfwVisible);
  const setNsfwVisible = useHome((s) => s.setNsfwVisible);
  const openShelf = useHome((s) => s.openShelf);
  const toggleShelf = useHome((s) => s.toggleShelf);
  const pick = useHome((s) => s.pick);
  const cols = useColumns(6, 4);
  const searchRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<{ view: EntityView; anchor: Anchor } | null>(null);

  const sections = useMemo(() => {
    return CATEGORY_ORDER.map((cat) => {
      const views = sortEntities(snapshot.library.entities.filter((e) => e.category === cat)).map((e) =>
        entityView(snapshot, picks, nsfwVisible, e),
      );
      return { cat, views: views.filter((v) => matchesQuery(v, query) && matchesChip(v, chip)) };
    });
  }, [snapshot, picks, nsfwVisible, query, chip]);
  const total = sections.reduce((n, s) => n + s.views.length, 0);
  const empty = snapshot.library.entities.length === 0;

  return (
    <>
      <Toolbar ref={searchRef} animateIn={replay} onToggleNsfw={() => setNsfwVisible(!nsfwVisible)} />
      <motion.div className="home" variants={staggerContainer(total, reduced, 0.12)} initial={replay ? "hidden" : false} animate="show">
        {empty ? (
          <motion.div className="home__empty" variants={riseIn(reduced)}>
            <h2>No skins found yet</h2>
            <p>Skin Switcher looks for mods in {snapshot.disk.modsPath ?? "your Mods folder"}. Add an archive, or check the folder in Settings.</p>
          </motion.div>
        ) : total === 0 ? (
          <motion.div className="home__empty" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: tween.small }}>
            <h2>Nothing matches</h2>
            <p>Try another search or filter.</p>
          </motion.div>
        ) : null}
        <LayoutGroup id="home-grid">
          <AnimatePresence initial={false}>
            {sections.map(({ cat, views }) =>
              views.length === 0 ? null : (
                <motion.section
                  key={cat}
                  layout="position"
                  className="home__section"
                  aria-label={CATEGORY_LABEL[cat]}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: tween.small }}
                  exit={{ opacity: 0, transition: tween.small }}
                  transition={spring.smooth}
                >
                  <motion.h2 className="caps home__heading" variants={riseIn(reduced)}>
                    {CATEGORY_LABEL[cat]} <span className="home__count">· <AnimatedNumber value={views.length} /></span>
                  </motion.h2>
                  <SectionGrid
                    cat={cat}
                    views={views}
                    cols={cols}
                    openShelf={openShelf}
                    reduced={reduced}
                    whenHidden={snapshot.settings.nsfw.whenHidden}
                    onToggle={toggleShelf}
                    onMenu={(view, anchor) => setMenu({ view, anchor })}
                  />
                </motion.section>
              ),
            )}
          </AnimatePresence>
        </LayoutGroup>
      </motion.div>
      <Popover open={!!menu} anchor={menu?.anchor ?? null} onClose={() => setMenu(null)} label="Quick switch">
        {menu && (
          <>
            <div className="caps menu-heading">{menu.view.entity.name}</div>
            <MenuItem checked={menu.view.effective === null} onSelect={() => { pick(menu.view.entity.id, null); setMenu(null); }}>
              Original
            </MenuItem>
            {menu.view.skins.map((s) => (
              <MenuItem key={s.id} checked={menu.view.effective === s.id} onSelect={() => { pick(menu.view.entity.id, s.id); setMenu(null); }}>
                {s.name}
              </MenuItem>
            ))}
          </>
        )}
      </Popover>
    </>
  );
}

function SectionGrid({
  views,
  cols,
  openShelf,
  reduced,
  whenHidden,
  onToggle,
  onMenu,
}: {
  cat: Category;
  views: EntityView[];
  cols: number;
  openShelf: string | null;
  reduced: boolean;
  whenHidden: "stub" | "invisible";
  onToggle: (id: string) => void;
  onMenu: (v: EntityView, anchor: Anchor) => void;
}) {
  // the shelf goes after the last card in the open card's row
  const openIdx = views.findIndex((v) => v.entity.id === openShelf);
  const rowEnd = openIdx < 0 ? -1 : Math.min(Math.floor(openIdx / cols) * cols + cols - 1, views.length - 1);
  const children: ReactNode[] = [];
  views.forEach((v, i) => {
    children.push(
      <EntityCard
        key={v.entity.id}
        view={v}
        open={v.entity.id === openShelf}
        reduced={reduced}
        onToggle={() => onToggle(v.entity.id)}
        onContextMenu={(e) => onMenu(v, { x: e.clientX, y: e.clientY })}
      />,
    );
    // shelves are direct siblings so opening one and closing another animate at the same time
    if (i === rowEnd && openIdx >= 0) {
      const ov = views[openIdx];
      children.push(<Shelf key={`shelf-${ov.entity.id}`} view={ov} reduced={reduced} whenHidden={whenHidden} />);
    }
  });
  return (
    <div className="home__grid" style={{ ["--cols" as string]: cols }}>
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </div>
  );
}
