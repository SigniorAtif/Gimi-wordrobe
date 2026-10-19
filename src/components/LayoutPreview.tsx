import type { Snapshot } from "../api/types";
import { api } from "../api";
import "./LayoutPreview.css";

/** Live miniature of each layout mode, drawn from the user's own entities (Settings › Appearance). */
export function LayoutPreview({ mode, snapshot }: { mode: "pages" | "shelves"; snapshot: Snapshot }) {
  const ents = snapshot.library.entities.filter((e) => e.category === "character");
  const pick = (n: number) => Array.from({ length: n }, (_, i) => ents[i % Math.max(ents.length, 1)]);
  const cover = (entityId: string | undefined) => {
    if (!entityId) return undefined;
    const active = snapshot.disk.active[entityId]?.[0];
    const skin = snapshot.library.skins.find((s) => s.id === active);
    const file = skin && !skin.nsfw ? skin.previews[0]?.file : undefined;
    return file ? api.assetUrl(file) : undefined;
  };
  const portrait = (p?: string) => (p ? api.assetUrl(p) : undefined);

  if (mode === "pages") {
    return (
      <div className="lp lp--pages" aria-hidden>
        <div className="lp__bar" />
        <div className="lp__grid lp__grid--5">
          {pick(10).map((e, i) => (
            <div key={i} className="lp__card">
              {cover(e?.id) && <img src={cover(e?.id)} alt="" decoding="async" />}
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="lp lp--shelves" aria-hidden>
      <div className="lp__bar" />
      <div className="lp__grid lp__grid--6">
        {pick(6).map((e, i) => (
          <div key={i} className={`lp__tile ${i === 1 ? "is-open" : ""}`}>
            <span className="lp__dot">{portrait(e?.portrait) && <img src={portrait(e?.portrait)} alt="" />}</span>
          </div>
        ))}
      </div>
      <div className="lp__shelf">
        {pick(4).map((e, i) => (
          <div key={i} className="lp__skin">
            {cover(e?.id) && <img src={cover(e?.id)} alt="" decoding="async" />}
          </div>
        ))}
      </div>
      <div className="lp__grid lp__grid--6">
        {pick(6).map((e, i) => (
          <div key={i} className="lp__tile">
            <span className="lp__dot">{portrait(e?.portrait) && <img src={portrait(e?.portrait)} alt="" />}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
