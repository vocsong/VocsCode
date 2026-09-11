# Themes

Thirteen themes: **System**, **Light** and **Dark**, plus ten palettes grouped by family in the **View** menu and in the swatch picker under *Settings → General*.

| Family | Theme | |
| --- | --- | --- |
| Navy | **Midnight Navy** | deep classic navy, azure accent |
| | **Abyss** | navy pushed to near-black, high contrast, aqua accent |
| | **Blueprint** | navy ink on blue-tinted drafting paper — the light side of navy |
| | **Admiral** | navy hull, parchment text, brass fittings |
| Futuristic | **Nebula** | navy-indigo with neon cyan and magenta — animated |
| Light | **Solarium** | warm sand paper, burnt-orange accent |
| | **Blossom** | pale rose paper, plum accent |
| Dark | **Evergreen** | dark conifer greens, mint accent |
| | **Graphite** | achromatic — no hue in the chrome, only in status colors |
| | **Ember** | charred warm dark, ember-orange accent |

**Nebula** is the animated one: a drifting aurora and a sliding holographic grid behind frosted, translucent chrome, gradient sweeps across the wordmark and primary buttons, a light bar travelling along the title bar's edge, and glow on status lights, the selected session and focus rings. All of its motion stops under `prefers-reduced-motion`.

A theme is data rather than a stylesheet. `src/shared/themes.ts` holds one palette of twenty tokens per theme and everything reads from it: the renderer's custom properties (emitted by `themeCss()`), the OS-drawn caption buttons and window background in the main process, the terminal's sixteen ANSI slots (`src/shared/ansi.ts` derives them per theme, so program output matches the UI), and the settings swatches. Tinted washes such as `--accent-soft` are `color-mix`ed once in `styles.css`, so a palette only declares base hues. Adding a theme means adding one entry — `tests/themes.test.ts` then holds it to the same bar as the others: every token present, WCAG AA body text, readable status hues, and a palette visibly distinct from all its siblings. Only Light and Dark are hand-authored in `styles.css`, so a complete palette exists before any script runs.
