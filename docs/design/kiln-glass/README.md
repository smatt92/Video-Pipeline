# Kiln Glass — design source

Copied from Sahil's Claude Design canvas "Kiln — Studio Redesign"
(https://claude.ai/artifact/1D36uutL8KGg1DZm6JWpyk), 08-Oct-2026.

- `project/glass.css` — tokens + components v0.2 (themes: Mint `.pa`, Ember `.pb`, Ocean `.pc`, Aurora `.pd`, Rose `.pe`, Graphite `.pf`; glow states `.idle/.gen/.alert`; `.solid` reduced transparency)
- `project/GlassThemes.dc.html` — the colour-theme picker (Settings → Appearance) with a live preview
- `project/GlassTokens.dc.html` — token sheet (contrast notes, type scale, radius/blur/grain)
- `project/GlassHome.dc.html` (1440×900), `project/GlassHomeM.dc.html` (412×915)
- `project/GlassStudio.dc.html` (1440×900) — full-bleed canvas Studio
- `project/canvas.json` — the canvas index

Reference only: these are Design Component pages, not app code. The app implements the same
tokens as CSS variables in `src/styles/` and React components.
