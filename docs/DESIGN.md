# Design system

Source of truth for tokens: `src/styles/tokens.css` (colour, type, radii, spacing, shadows) and `src/motion.ts`
(springs, durations, stagger). This file explains the intent.

## Colour (Restrained strategy)
- Neutrals are OKLCH tinted toward the accent hue (275) at very low chroma. Never pure black or white.
- Elevation: `--bg` (window) < `--surface-1` (cards, toolbar) < `--surface-2` (shelf, panels, inputs)
  < `--surface-3` (popovers, menus, toasts). Each step is about +0.04 lightness with a 1px border.
- One accent, soft violet-blue `--accent`. Only for: active state, focus rings, the primary button.
- `--pending` (yellow) only for PENDING. `--danger` (red) only for conflicts, errors and the 18+ tag.

## Type
- Inter Variable, bundled locally. One family for everything.
- Scale (px): 11 caps-label, 12 meta, 13 body-small, 14 body, 16 title, 20 page title, 26 detail title.
- Tabular numbers (`font-variant-numeric: tabular-nums`) for every count.
- Section labels are 11px uppercase with letter-spacing, `--text-3`.

## Shape and depth
- Radius: cards 14px, buttons and inputs 10px, chips fully round, keycaps 6px.
- Shadows are soft and layered, darker than the background; cards lift 2px with a larger shadow on hover.

## Components
- Buttons: primary (accent fill), secondary (surface-2 + border), ghost. States: hover, focus-visible ring,
  active scale 0.98, disabled, loading (spinner inside the button only).
- Chips: filter chips (pill, selected = accent tint + accent text), tag chips (ACTIVE accent, PENDING yellow, 18+ red).
- Cover art: 3:4, `object-fit: cover`, bottom gradient behind the name. Missing cover = generated monogram art.

## Motion
See SPEC §7 and `src/motion.ts`. Springs `snappy` / `smooth` / `gentle`, ease-out `[0.22, 1, 0.36, 1]`,
stagger 25-35ms capped at 400ms per grid. Only transform, opacity and (sparingly) filter.
Reduced motion (system or Settings) = crossfades only.
