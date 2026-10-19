# Wireframes

Rendered from the "Skin Switcher — Wireframes" Claude Design canvas
(https://claude.ai/artifact/4K79UrPWJ4JqxGZJFQf6Qn, needs the owner's login).
Each PNG is one 1600×800 board: a 1280×800 app window on the left and the designer's numbered notes on the right.
`source/` holds the original board markup (`.dc.html`) and `canvas.json`. The markup needs the canvas runtime to
render, but it's readable as-is for exact copy text and sizes.

| Board | File | Mode |
|---|---|---|
| A1 Home (grid) | `A1-Home.png` | Pages |
| A2 Character page | `A2-Character.png` | Pages |
| A3 Skin detail | `A3-Detail.png` | shared |
| A4 Add skin dialog | `A4-Add.png` | shared |
| A5 Settings | `A5-Settings.png` | shared |
| C1 Home (shelf grid) | `C1-Home.png` | Shelves |
| C2 Shelf expanded | `C2-Shelf.png` | Shelves |
| C3 Shelf quick peek | `C3-Detail.png` | Shelves |
| C4 Drop on card | `C4-Add.png` | Shelves |
| C5 Settings | `C5-Settings.png` | shared |

## Where SPEC.md overrides the wireframes

The wireframes are grayscale layout sketches made before the spec's later revisions. Use them for layout, structure
and copy. Where they disagree, **SPEC.md wins**:

- **Look:** grayscale, IBM Plex and amber notes are sketch styling only. Use SPEC §2: layered near-black surfaces, one soft violet-blue accent, an Inter-like variable font, yellow only for PENDING, red for conflicts and 18+.
- **Default disable method:** the wireframes show "Rename with DISABLED prefix" as the default. The spec's default is **Move to Library stash**.
- **A1:** the wireframe uses category tabs and 8 small portrait cards per row. The spec's A1 uses the same sectioned grid and filter chips as C1, with 5 columns of large cards showing the active skin's cover as a backdrop.
- **Settings:** A5 and C5 are one shared page. The spec adds an **Appearance** section (Pages / Shelves layout switch with live thumbnails, Reduce motion), the Libraries list and "Update hash index".
- **C3 on narrow windows:** the wireframe suggests a modal. The spec opens A3 instead below about 1100px.
- **Toast:** always bottom-right (A3's board shows it bottom-centre).
- **Tags:** use ACTIVE for applied and PENDING for picked-but-not-applied (C2/C3 show "ON").
- **Counts and data:** Weapons is 3 (A Teaspoon of Transcendence is Sandrone's weapon), and Varesa has 1 SFW + 3 NSFW skins, so "+3", not "+4". Hotkeys shown for Kazuha are placeholders; real ones come from the ini (SPEC §8).
- **Motion:** the boards are static. All of SPEC §7 applies.
