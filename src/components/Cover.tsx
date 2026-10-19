import { api } from "../api";
import type { Skin } from "../api/types";
import { hueFor } from "../lib/derive";
import { Flip } from "./Flip";
import "./Cover.css";

/**
 * A skin's 3:4 cover (SPEC §2, §10): the first preview, a neutral placeholder for NSFW while hidden,
 * or the empty "+ Add preview" state.
 */
export function Cover({
  skin,
  hidden,
  label,
  className,
  flip,
  reduced = false,
}: {
  skin: Skin;
  hidden?: boolean;
  label?: boolean;
  className?: string;
  /** morphs to/from the A3 big preview (SPEC §7) */
  flip?: boolean;
  reduced?: boolean;
}) {
  const first = skin.previews[0];
  if (hidden) {
    return (
      <div className={`cover cover--hidden ${className ?? ""}`}>
        <span className="cover__note">Hidden</span>
      </div>
    );
  }
  if (!first) {
    return (
      <div className={`cover cover--empty ${className ?? ""}`} style={{ ["--hue" as string]: hueFor(skin.id) }}>
        <span className="cover__note">+ Add preview</span>
        {label && <span className="cover__name">{skin.name}</span>}
      </div>
    );
  }
  return (
    <Flip flipKey={flip ? `skin:${skin.id}` : `cover:${skin.id}:static`} className={`cover ${className ?? ""}`} reduced={reduced || !flip} radius={10}>
      <img src={api.assetUrl(first.file)} alt="" loading="lazy" decoding="async" draggable={false} />
      {label && <span className="cover__name">{skin.name}</span>}
    </Flip>
  );
}
