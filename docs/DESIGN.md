# Design system

Source of truth for tokens: `src/styles/tokens.css` (colour, type, radii, spacing, shadows) and `src/motion.ts`
(springs, durations, stagger). Shared primitives live in `src/styles/components.css`. This file explains the intent.

## Scene
A player at their gaming PC at night, game minimized, dim room, swapping a character's outfit in a few seconds and
pressing F10. Dark, calm chrome; the skin art carries the colour. A wardrobe, not a dashboard.

## Colour (Restrained, plus ambient art colour)
- Neutrals are warm charcoal: OKLCH hue 70 at chroma 0.005 to 0.01. Never pure black or white.
- Elevation: `--bg-deep` (input wells) < `--bg` (window) < `--surface-1` (cards, search) < `--surface-2` (shelf,
  sheets, dialogs) < `--surface-3` (popovers, menus, toasts). About +0.045 lightness per step.
- One accent, jade `--accent` (`oklch(0.8 0.13 165)`). Only for: the active state, focus rings, the primary button.
  Filter chips and "new" tags stay neutral.
- `--pending` (yellow) only for PENDING. `--danger` (red) only for conflicts, errors and the 18+ tag.
- Ambient art colour (`src/lib/ambient.ts`): the dominant colour of the active cover, sampled from a 24x32 canvas
  copy (chroma-weighted average in OKLab, cached per URL, sampled when idle). It glows behind the open shelf, the A2
  header and the A3 detail (`components/Ambient.tsx`), crossfading on change. Glows sit at lightness 0.30 with
  chroma capped at 0.09 and mix in at 55% or less, so `--text-3` on top still clears 4.5:1. A tainted canvas or a
  broken image means no glow, nothing else.

## Type
- Inter Variable for all UI text: labels, buttons, data, body.
- Bricolage Grotesque Variable (OFL, bundled from `@fontsource-variable/bricolage-grotesque`, weight, width and
  optical-size axes) for names and titles only: entity names, skin names, page and section titles.
- Scale (px): 11 caps-label, 12 meta, 13 body-small, 14 body, then headings 1.25x apart: 17.5 title, 22 page,
  28 detail, 36 display. Names use a slightly condensed width (92 to 94%) so long names fit.
- Tabular numbers (`.num`) for every count. Section labels inside forms are 11px caps, `--text-3`.

## Shape and depth
- Radius: cards 14px, art 12px, buttons and inputs 10px, sheets and dialogs 20px, chips round, keycaps 6px.
- Lighter surfaces carry elevation. Shadows only for things that float (popovers, sheets, hovered cards).

## Components
- Buttons: primary (jade), secondary (surface-1 + hairline), ghost, danger; `--lg` for Apply. Press scales 0.98.
- Art card (`.skincard`, `.bigcard`): the cover is the card. The name plate sits on a bottom scrim; the ACTIVE or
  PENDING tag hangs above the name; the selection ring is drawn outside the card so it never covers art. Unchosen
  covers desaturate once a skin is chosen.
- Pages cards: the active cover as a full backdrop with the display name set on it. Pending adds a yellow outline.
- Compact cards (C1): a rail of ticks replaces the dots (one per visible skin, the chosen one filled). Pending tints
  the card and turns the subtitle yellow; "!" sits on the portrait corner; entities with no skins step back.
- Pending sheet: a bottom sheet with a large yellow count, a two-line `name / from → to` diff per change, and Apply.
- Toolbar: search leads (40px, widest control); filters are quiet text on a sliding neutral pill.
- Empty states: a hanger line drawing, a display headline, one line of help and a next step.

## Motion
See SPEC §7 and `src/motion.ts`. Springs `snappy` / `smooth` / `gentle`, plus `pop` for radio fills (one small
overshoot, no bounce). Ease out `[0.22, 1, 0.36, 1]`, stagger 25-35ms capped at 400ms per grid, ambient glows
crossfade over 450ms. Only transform, opacity and (sparingly) filter. Reduced motion (system or Settings) =
crossfades only.
