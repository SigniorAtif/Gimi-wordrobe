import { api } from "../api";
import type { Entity, Skin } from "../api/types";
import { hueFor, initials } from "../lib/derive";
import "./Portrait.css";

/**
 * Entity portrait: its own portrait image, else the active skin's cover (unless hidden NSFW), else a monogram.
 * Characters are round; weapons and extras are rounded squares.
 */
export function Portrait({
  entity,
  cover,
  size = 48,
  hidden,
}: {
  entity: Entity;
  cover?: Skin | null;
  size?: number;
  hidden?: boolean;
}) {
  const src = entity.portrait
    ? api.assetUrl(entity.portrait)
    : !hidden && cover?.previews[0]
      ? api.assetUrl(cover.previews[0].file)
      : "";
  const hue = hueFor(entity.name);
  return (
    <span
      className={`portrait portrait--${entity.category}`}
      style={{ width: size, height: size, ["--hue" as string]: hue }}
      aria-hidden
    >
      {src ? (
        <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />
      ) : (
        <span className="portrait__mono" style={{ fontSize: Math.round(size * 0.34) }}>
          {initials(entity.name)}
        </span>
      )}
    </span>
  );
}
