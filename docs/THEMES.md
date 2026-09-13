# Themes

Twenty-three themes: the three core themes, **System**, **Light** and **Dark**, plus twenty data palettes grouped by family in the **View** menu and in the swatch picker under *Settings → General*.

| Family | Theme | Description |
| --- | --- | --- |
| Core | **System** | Follow the OS light/dark setting. |
| | **Light** | The default neutral light palette. |
| | **Dark** | The default neutral dark palette. |
| Navy | **Midnight Navy** | Deep classic navy with a clear azure accent. |
| | **Abyss** | Navy pushed to near-black, high contrast, aqua accent. |
| | **Blueprint** | Navy ink on blue-tinted drafting paper — the light side of navy. |
| | **Admiral** | Navy hull, parchment text, brass fittings. |
| Futuristic | **Nebula** | Futuristic navy-indigo with neon cyan and magenta — animated. |
| | **Ultraviolet** | Black-violet with an electric lavender accent. |
| | **Magma** | Charred black-brown split open by a lava-red accent. |
| Light | **Solarium** | Warm sand paper with a burnt-orange accent. |
| | **Blossom** | Pale rose paper with a plum accent. |
| | **Citrine** | Pale citron paper with a dark-gold accent. |
| | **Cappuccino** | Frothed-milk warm gray with a coffee-brown accent. |
| | **Meadow** | Soft grass-green paper with a forest accent. |
| | **Porcelain** | Cool glazed gray-white with a slate-blue accent. |
| | **Lavender** | Soft lilac paper with a deep violet accent. |
| Dark | **Evergreen** | Dark conifer greens with a mint accent. |
| | **Graphite** | Achromatic dark: no hue in the chrome, only in status colors. |
| | **Ember** | Charred warm dark with an ember-orange accent. |
| | **Lagoon** | Deep teal water with a coral-pink accent. |
| | **Fjord** | Slate-blue nordic dark with a frost-blue accent. |
| | **Claret** | Deep wine-dark maroon with a rose accent. |

**Nebula** is the animated one: a drifting aurora and a sliding holographic grid behind frosted, translucent chrome, gradient sweeps across the wordmark and primary buttons, a light bar travelling along the title bar's edge, and glow on status lights, the selected session and focus rings. All of its motion stops under `prefers-reduced-motion`.

A theme is data rather than a stylesheet. `src/shared/themes.ts` holds one palette of twenty tokens per theme and everything reads from it: the renderer's custom properties (emitted by `themeCss()`), the OS-drawn caption buttons and window background in the main process, the terminal's sixteen ANSI slots (`src/shared/ansi.ts` derives them per theme, so program output matches the UI), and the settings swatches. Tinted washes such as `--accent-soft` are `color-mix`ed once in `styles.css`, so a palette only declares base hues. Adding a theme means adding one entry — `tests/themes.test.ts` then holds it to the same bar as the others: every token present, WCAG AA body text, readable status hues, and a palette visibly distinct from all its siblings. Only Light and Dark are hand-authored in `styles.css`, so a complete palette exists before any script runs.
