import { api } from "../api";
import type { Skin } from "../api/types";
import { hueFor } from "../lib/derive";
import "./Cover.css";

/**
 * A skin's 3:4 cover (SPEC §2, §10): the first preview, a neutral placeholder for NSFW while hidden,
 * or the empty "+ Add preview" state.
 */
export function Cover({ skin, hidden, label, className }: { skin: Skin; hidden?: boolean; label?: boolean; className?: string }) {
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
    <div className={`cover ${className ?? ""}`}>
      <img src={api.assetUrl(first.file)} alt="" loading="lazy" decoding="async" draggable={false} />
      {label && <span className="cover__name">{skin.name}</span>}
    </div>
  );
}
