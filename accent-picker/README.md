<p align="center"><img src="../assets/accent-picker.jpg" alt="Accent Picker: official Hermes Desktop plugin" width="100%"></p>

# Accent Picker — Hermes Desktop plugin

> Part of [Hermes Official Plugins](../README.md), Nous Research's official plugins for Hermes Agent. Formerly [`NousResearch/hermes-desktop-accent-picker`](https://github.com/NousResearch/hermes-desktop-accent-picker), which is archived; this directory carries its full history.

An OKLCH colour wheel in the Hermes Desktop status bar. Drag it and the whole
theme retints live; the palette re-derives from the one colour you pick. It is
an **authoring tool** for theme designers — the colour is scratch state and is
never persisted. Two palette commands come with it: *Accent: reset to the theme
default* and *Accent: copy the current color*.

It used to ship bundled with the app (off by default). It now lives here as a
desktop plugin so the app's plugin list only carries things most
users want.

## Install

From the Hermes plugin catalog: Hermes Desktop → **Capabilities → Plugins**, search **accent-picker**, install. Or from a terminal:

```bash
hermes plugins install accent-picker
```

The app copies `desktop/plugin.js` into `~/.hermes/desktop-plugins/` and loads it within a few seconds; flip the switch in Capabilities → Plugins to enable it.

## Layout

- `desktop/plugin.js` — the loadable artifact. Plain ESM, only imports
  `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime` (the three specifiers
  the desktop plugin loader resolves).
- `src/plugin.tsx`, `src/picker.tsx` — the TSX source it is built from.
- `plugin.yaml` — the manifest the catalog and `hermes plugins` read.

## Build

```bash
npm install
npm run build   # esbuild src/plugin.tsx → desktop/plugin.js
```

Commit the rebuilt `desktop/plugin.js`; the desktop loads files uncompiled, so the
artifact is what ships.

## SDK

Everything the picker uses comes from `@hermes/plugin-sdk`: `$accentOverride`,
`setAccentOverride`, the OKLCH helpers (`hexToOklch`, `oklchToHex`,
`oklchToSrgb255`, `maxChroma`, `contrastRatio`), `Popover*`, `useTheme`,
`useValue`, `STATUSBAR_AREAS`, `PALETTE_AREA`. Reference:
https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk

## Reimagined build (Accent Picker+)

A community rework of this plugin, built on top of the original by **Teknium**.
It turns the authoring-only picker into a full user-facing theme editor while
keeping the original's OKLCH field, swatches and commands:

- **Full square field.** The chroma/lightness square painted every
  out-of-sRGB-gamut pixel transparent (`oklchToSrgb255` returns `null` outside
  gamut), which carved a wedge out of the panel for saturated hues. Out-of-gamut
  pixels are now gamut-clipped per row against `maxChroma(l, hue)`, so the
  picker is always a full square.
- **Durable accent.** The picker no longer stops at the scratch
  `$accentOverride` preview: *Save as theme* re-derives the palette with the SDK's
  `retintTheme` and installs the result as a user theme, written through the
  host's `window.hermesDesktop.uiPreferences` bridge so the ui-preferences sync
  cannot clobber it. Selection survives restarts and plugin reloads.
- **Colors tab.** Every palette slot (background, sidebar, card, popover,
  border, input, …) can be recolored with the same OKLCH field, editing the
  palette the current mode actually paints. Updates apply **live while you
  drag** (throttled to ~8 fps so the theme install stays smooth).
- **Reset / Revert / Restore.** Per-slot *Reset to default* (back to the base
  theme's color) and *Revert edit* (back to the color before the edit), plus a
  *Restore base theme* button and an *Accent+: revert the last color edit*
  palette command. Undo history is capped at 25 entries.
- **Safer mode handling.** Slot edits now target the palette `paletteFor(seed,
  resolvedMode)` actually reads (branching on the luminance-derived
  `renderedMode` made edits land in a palette the other mode never reads once an
  edit brightened the background).

The artifact in `desktop/plugin.js` is the shipped, tested build; `src/` still
holds the original picker source and will be synced in a follow-up.

MIT.
