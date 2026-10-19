import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Category, Snapshot } from "../api/types";
import { AnimatedNumber } from "../components/AnimatedNumber";
import { EntityCard } from "../components/EntityCard";
import { PageCard } from "../components/PageCard";
import { MenuItem, Popover, type Anchor } from "../components/Popover";
import { Shelf } from "../components/Shelf";
import { rememberFlipKey } from "../components/Flip";
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
import { useClashes } from "../lib/conflicts";
import { useColumns } from "../lib/useColumns";
import { useReduced } from "../lib/useReduced";
import { riseIn, spring, staggerContainer, tween } from "../motion";
import { useApp } from "../store/app";
import { useHome } from "../store/home";
import { useAdd } from "../store/add";
import "./Home.css";

/** Mode C home (C1 + C2): one scrolling page of sections; a card's shelf opens under its row (SPEC §6). */
export function Home({ snapshot }: { snapshot: Snapshot }) {
  // re-render on navigation so the outgoing page's shared elements snapshot their layout before the morph
  useApp((s) => s.route);
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
  const setMorph = useHome((s) => s.setMorph);
  const navigate = useApp((s) => s.navigate);
  const layout = snapshot.settings.layout;
  const clashes = useClashes();
  const dragging = useAdd((s) => s.drag.active && s.drag.kind === "archive");
  const dropOver = useAdd((s) => (s.drag.over?.kind === "entity" ? s.drag.over.id : s.drag.over?.kind === "new" ? `new:${s.drag.over.category}` : null));
  const shelfCols = useColumns(6, 4);
  const pageCols = useColumns(5, 4);
  const cols = layout === "pages" ? pageCols : shelfCols;
  // the card's portrait / cover morphs into the next page's hero (SPEC §7)
  const openEntity = (id: string) => {
    setMorph({ entity: id });
    rememberFlipKey(`entity:${id}`);
    navigate({ name: "entity", entityId: id });
  };
  const openSkin = (id: string) => {
    rememberFlipKey(`skin:${id}`);
    navigate({ name: "skin", skinId: id });
  };

  // switching layouts keeps context (SPEC §6): the open shelf becomes the focused card, and back again
  useEffect(() => {
    const h = useHome.getState();
    const id = h.openShelf ?? h.contextEntity;
    if (!id) return;
    if (layout === "shelves") {
      if (!h.openShelf) h.toggleShelf(id);
      return;
    }
    const t = setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-entity="${id}"]`);
      el?.scrollIntoView({ block: "nearest" });
      el?.focus({ preventScroll: true });
    }, 60);
    return () => clearTimeout(t);
  }, [layout]);
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
                  {layout === "pages" ? (
                    <PagesGrid
                      views={views}
                      cols={cols}
                      reduced={reduced}
                      conflicts={clashes.conflictEntities}
                      onOpen={openEntity}
                      onMenu={(view, anchor) => setMenu({ view, anchor })}
                    />
                  ) : (
                    <SectionGrid
                      cat={cat}
                      newTiles={dragging && cat === "character"}
                      dropOver={dropOver}
                      views={views}
                      cols={cols}
                      openShelf={openShelf}
                      reduced={reduced}
                      whenHidden={snapshot.settings.nsfw.whenHidden}
                      conflicts={clashes.conflictEntities}
                      onToggle={toggleShelf}
                      onOpenPage={openEntity}
                      onDetails={openSkin}
                      onMenu={(view, anchor) => setMenu({ view, anchor })}
                    />
                  )}
                </motion.section>
              ),
            )}
          </AnimatePresence>
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

function PagesGrid({
  views,
  cols,
  reduced,
  conflicts,
  onOpen,
  onMenu,
}: {
  views: EntityView[];
  cols: number;
  reduced: boolean;
  conflicts: Set<string>;
  onOpen: (id: string) => void;
  onMenu: (v: EntityView, anchor: Anchor) => void;
}) {
  return (
    <div className="home__grid home__grid--pages" style={{ ["--cols" as string]: cols }}>
      <AnimatePresence initial={false}>
        {views.map((v) => (
          <PageCard
            key={v.entity.id}
            view={v}
            reduced={reduced}
            conflict={conflicts.has(v.entity.id)}
            onOpen={() => onOpen(v.entity.id)}
            onContextMenu={(e) => onMenu(v, { x: e.clientX, y: e.clientY })}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

function SectionGrid({
  views,
  newTiles,
  dropOver,
  cols,
  openShelf,
  reduced,
  whenHidden,
  conflicts,
  onToggle,
  onOpenPage,
  onDetails,
  onMenu,
}: {
  cat: Category;
  views: EntityView[];
  /** "+ New character" and "+ New weapon / extra" tiles while an archive is dragged (C4) */
  newTiles: boolean;
  dropOver: string | null;
  cols: number;
  openShelf: string | null;
  reduced: boolean;
  whenHidden: "stub" | "invisible";
  conflicts: Set<string>;
  onToggle: (id: string) => void;
  onOpenPage: (id: string) => void;
  onDetails: (skinId: string) => void;
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
        conflict={conflicts.has(v.entity.id)}
        dropHover={dropOver === v.entity.id}
        onToggle={() => onToggle(v.entity.id)}
        onContextMenu={(e) => onMenu(v, { x: e.clientX, y: e.clientY })}
      />,
    );
    // shelves are direct siblings so opening one and closing another animate at the same time
    if (i === rowEnd && openIdx >= 0) {
      const ov = views[openIdx];
      children.push(
        <Shelf
          key={`shelf-${ov.entity.id}`}
          view={ov}
          reduced={reduced}
          whenHidden={whenHidden}
          onOpenPage={() => onOpenPage(ov.entity.id)}
          onDetails={onDetails}
        />,
      );
    }
  });
  if (newTiles) {
    for (const [key, label] of [
      ["new:character", "+ New character"],
      ["new:other", "+ New weapon / extra"],
    ] as const) {
      children.push(
        <motion.div
          key={key}
          className={`home__newtile ${dropOver === key ? "is-drop-hover" : ""}`}
          data-drop={key}
          initial={reduced ? { opacity: 0 } : { opacity: 0, x: -14 }}
          animate={{ opacity: 1, x: 0, transition: spring.smooth }}
          exit={{ opacity: 0, transition: tween.micro }}
        >
          {label}
        </motion.div>,
      );
    }
  }
  return (
    <div className="home__grid" style={{ ["--cols" as string]: cols }}>
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </div>
  );
}
