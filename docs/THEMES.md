# Themes

A color theme is two independent choices, both under *Settings → Appearance → Color theme* (the **View → Theme** menu item opens it):

- **Mode**: **System**, **Light** or **Dark**. System follows the OS and switches live when the OS does.
- **Palette**: one of twenty color families. Every palette has a light and a dark variant, so the mode carries across every palette switch, and any palette works with System.

| Family | Palette | Description |
| --- | --- | --- |
| Neutral | **Default** | The signature Vocs palette: neutral grays with an indigo accent. |
| | **Graphite** | Pure grayscale chrome; color only where it carries meaning. |
| | **Slate** | Cool blue-gray surfaces with a dusty periwinkle accent. |
| | **Stone** | Warm putty grays with a terracotta accent. |
| Cool | **Midnight** | Calm navy with a clear azure accent. |
| | **Abyss** | Deep ocean blue with an aqua accent. |
| | **Fjord** | Nordic slate-blue with a soft frost accent. |
| | **Admiral** | Navy hull, parchment text and brass fittings. |
| Nature | **Evergreen** | Pine-forest greens with a jade accent. |
| | **Meadow** | Soft sage with a fresh leaf-green accent. |
| | **Lagoon** | Tropical teal water with a coral accent. |
| | **Citrine** | Olive-tinted neutrals with a citron accent. |
| Warm | **Ember** | Charcoal with a glowing ember-orange accent. |
| | **Cappuccino** | Coffee-house browns with a caramel accent. |
| | **Solarium** | Sun-warmed sand with a deep teal ink accent. |
| | **Claret** | Wine-cellar reds with a soft rose accent. |
| Vivid | **Ultraviolet** | Deep violet with a lavender accent. |
| | **Blossom** | Muted petal tones with a peony-pink accent. |
| | **Dusk** | Twilight plum-gray with an orchid accent. |
| | **Nebula** | Indigo space with a cyan glow, subtly animated. |

**Nebula** is the animated palette: a drifting aurora and a sliding holographic grid behind frosted, translucent chrome, gradient sweeps across the wordmark and primary buttons, a light bar travelling along the title bar's edge, and glow on status lights, the selected session and focus rings. The light variant keeps the motion but turns the aurora, grid and glows down. All of its motion stops under `prefers-reduced-motion`.

## Design rules

The palettes are built for long sessions of reading transcripts, diffs and terminal output. Every variant was derived in OKLCH from one recipe, and `tests/themes.test.ts` holds all forty to it:

- **Readable but not glaring.** Body text sits between 11:1 and 16:1 against the ground. It is off-white on dark and off-black on light, never pure white on black.
- **AA everywhere text appears.** Secondary text, the accent (used for links and labels), the label on the accent, and all six status hues clear 4.5:1. Faint text clears 3:1.
- **Calm surfaces.** Grounds are softly tinted and capped in chroma. No light ground is pure white and no dark ground is pure black. Accents are capped below neon.
- **Status means the same thing everywhere.** Green, amber, red, blue, purple and cyan sit on fixed hue anchors in every palette, so a palette never changes what a badge means.
- **Distinct within a scheme.** Any two palettes in the same scheme differ perceptually (OKLab distance of the accent, plus the ground weighted double).

## How it's built

A palette is data rather than a stylesheet. `src/shared/themes.ts` holds a light and a dark variant of twenty tokens per palette, and everything reads from it:

- the renderer's custom properties, emitted by `themeCss()` as one block per variant keyed on `html:root[data-palette][data-scheme]`;
- the OS-drawn caption buttons and window background in the main process;
- the terminal's sixteen ANSI slots (`src/shared/ansi.ts` derives them per variant, so program output matches the UI);
- the settings swatches.

`src/renderer/src/theme.ts` keeps three attributes on `<html>`:

- `data-theme` holds the mode the user chose;
- `data-palette` holds the palette;
- `data-scheme` holds the mode resolved against the OS, and it is the only one the CSS reads.

The main process sets `nativeTheme.themeSource` to the mode. Tinted washes such as `--accent-soft` are `color-mix`ed once in `styles.css`, so a variant only declares base hues. `styles.css` also carries the Default palette's two variants as a pre-script fallback, so a complete palette exists before any script runs. A test keeps that fallback identical to the data.

Settings store the mode under `theme` (kept for compatibility with older settings files) and the palette under `palette`. Builds before this one stored a single theme id from a flat list of 23. On load, `migrateTheme()` splits such an id into the palette it became and the mode it used to paint:

- `blueprint` becomes Midnight, Light;
- `porcelain` becomes Slate, Light;
- `lavender` becomes Ultraviolet, Light;
- `magma` becomes Ember, Dark;
- every other old palette keeps its name, in the mode it used to paint.

Adding a palette means adding one entry with both variants; the tests then hold it to the same bar as the others.

## Text & fonts

The same Appearance page has a **Text & fonts** group (`src/shared/typography.ts`, `components/TypographySettings.tsx`):

| Setting | Choices | Applies to |
| --- | --- | --- |
| Interface size | 90%, 100%, 110%, 125% | The whole window, as the zoom factor the main process sets |
| Interface font | System default, or an installed preset (Inter, Segoe UI, Roboto, Noto Sans, IBM Plex Sans, Open Sans, Helvetica / Arial, Verdana, Atkinson Hyperlegible), or a custom family | `--font` |
| Transcript font | Same as interface (default), System default, Reading serif (Charter or Georgia), any interface preset, or custom | `--content-font`: messages from you and your agents |
| Code font | Default monospace, or Cascadia Code / Mono, JetBrains Mono, Fira Code, Source Code Pro, IBM Plex Mono, Consolas, SF Mono / Menlo, Courier New, or custom | `--mono`: code blocks, diffs, paths and the terminal |
| Transcript text size | 12–20 px (default 14) | `--content-size`: transcript prose, your messages and the composer |
| Code text size | 11–16 px (default 12.5) | `--code-size`: code blocks and diffs. The terminal keeps its own size under *Terminal* |
| Line spacing | Compact 1.5, Normal 1.65, Relaxed 1.8 | `--content-leading` |
| Transcript width | Narrow, Normal, Wide | `data-width`: the conversation column and the prose line length together |

Interface size is a zoom because the chrome's type is authored in fixed pixels. A zoom scales it without breaking the layout. Everything else is a custom property on `<html>`, and `styles.css` declares the same defaults, so nothing shifts before settings load. Zen keeps its slightly larger reading type as offsets from these variables, so the settings move it too.

Fonts are referenced, never bundled:

- Each preset is a named family followed by the role's default stack, so a missing font degrades gracefully.
- The picker measures text on a canvas to mark presets that are not installed on this computer.
- A custom family name is reduced to letters, digits, spaces and `-_.`, then quoted, so it can only ever name a font.
