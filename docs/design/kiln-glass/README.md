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

## Decisions after the canvas (08-Oct)

- **Studio has no full-bleed picture behind its controls for now** (Sahil, 18:28). The canvas
  behind the prompt, settings and filmstrip is the ambient glow only; pictures appear in the
  filmstrip thumbnails. Text over arbitrary generated imagery cannot be held to the contrast
  bar the glass panels meet, so it waits until a scrim is designed and checked against real
  frames. Add later.
- The kiln mark has a flue (option A) — `src/components/ui/logo.tsx`.
