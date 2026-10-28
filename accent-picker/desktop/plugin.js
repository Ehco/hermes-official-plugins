// Accent Picker+ — OKLCH accent picker with persistence and full palette editing.
//
// Improvements over the stock accent-picker:
//  1. The chroma/lightness square is always a full square: out-of-gamut pixels
//     are gamut-clipped (chroma reduced until they fit sRGB) instead of being
//     painted transparent, which carved a wedge out of the panel.
//  2. "Save as theme" persists the picked accent as a real user theme
//     (`hermes-desktop-user-themes-v1` in localStorage — the app reads that
//     synchronously at boot, so it survives restarts and plugin reloads).
//  3. A Colors tab: every palette slot (sidebar, card, popover, border, ...)
//     can be recolored with the same OKLCH field, in the active mode's palette.
import {
  $accentOverride,
  PALETTE_AREA,
  requestTheme,
  retintTheme,
  setAccentOverride,
  STATUSBAR_AREAS,
  THEMES_AREA,
  contrastRatio,
  hexToOklch,
  maxChroma,
  oklchToHex,
  oklchToSrgb255,
  Popover,
  PopoverContent,
  PopoverTrigger,
  useTheme,
  useValue
} from "@hermes/plugin-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

var SWATCHES = [
  { hex: "#0053FD", name: "Nous blue \xB7 263\xB0 (light seed)" },
  { hex: "#4a84fe", name: "Nous blue \xB7 263\xB0 (dark seed)" },
  { hex: "#1540B1", name: "Psyche blue \xB7 264\xB0" },
  { hex: "#0969da", name: "GitHub blue \xB7 257\xB0" },
  { hex: "#196d31", name: "GitHub green \xB7 148\xB0" },
  { hex: "#8250df", name: "GitHub purple \xB7 303\xB0" },
  { hex: "#bf3989", name: "GitHub pink \xB7 354\xB0" },
  { hex: "#bc4c00", name: "GitHub orange \xB7 52\xB0" }
];
var FIELD_W = 224;
var FIELD_H = 130;
var RAIL_H = 12;
var HEX_CH = 7;
var CHROMA_MAX = 0.33;
var OUR_NAME = "Custom (Accent Picker)";
var BASE_KEY = "accent-picker-plus:base";
var UNDO_KEY = "accent-picker-plus:undo";
var DEFAULTS_KEY = "accent-picker-plus:defaults";
var USER_THEMES_KEY = "hermes-desktop-user-themes-v1";

var clamp01 = (n) => Math.min(1, Math.max(0, n));

function hexToRgb255(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

// ── persistence ──────────────────────────────────────────────────────────────

var ctxRef = { current: null };

function notify(message) {
  const ctx = ctxRef.current;
  const host = ctx && (ctx.host || ctx);
  if (host && typeof host.notify === "function") {
    try {
      host.notify({ kind: "info", message });
    } catch {}
  }
}

function rememberBase(name) {
  // Derived themes carry a -light/-dark suffix; the bare skin name is the base.
  if (!name || name === OUR_NAME || name.startsWith(OUR_NAME + " -") || name.startsWith(OUR_NAME + "-")) {
    return;
  }
  try {
    localStorage.setItem(BASE_KEY, name.replace(/-(light|dark)$/, ""));
  } catch {}
}

function baseName() {
  try {
    return localStorage.getItem(BASE_KEY) || "nous";
  } catch {
    return "nous";
  }
}

// Try the stored base, then its bare form (deriveFrom names end -light/-dark).
// Never "restores" into our own custom theme.
function restoreBase() {
  const stored = baseName();
  const bare = stored.replace(/-(light|dark)$/, "");
  for (const candidate of [bare, stored]) {
    if (!candidate || candidate === OUR_NAME || candidate.startsWith(OUR_NAME + "-")) {
      continue;
    }
    if (requestTheme(candidate)) {
      return true;
    }
  }
  return false;
}

// ── undo stack + base defaults ───────────────────────────────────────────────

function readUndo() {
  try {
    return JSON.parse(localStorage.getItem(UNDO_KEY) || "[]") || [];
  } catch {
    return [];
  }
}

function writeUndo(list) {
  try {
    localStorage.setItem(UNDO_KEY, JSON.stringify(list.slice(-25)));
  } catch {}
}

function pushUndo(entry) {
  if (!entry) return;
  const list = readUndo();
  list.push(entry);
  writeUndo(list);
}

/** Pop the most recent entry, optionally limited to one slot. */
function popUndo(slotKey) {
  const list = readUndo();
  for (let i = list.length - 1; i >= 0; i--) {
    if (!slotKey || list[i].slot === slotKey) {
      const entry = list[i];
      writeUndo(list.slice(0, i).concat(list.slice(i + 1)));
      return entry;
    }
  }
  return null;
}

function readDefaults() {
  try {
    return JSON.parse(localStorage.getItem(DEFAULTS_KEY) || "null");
  } catch {
    return null;
  }
}

/** Snapshot the base palettes the first time we branch off the base theme. */
function captureDefaults(theme, resolvedMode) {
  try {
    const d = readDefaults() || {};
    if (resolvedMode === "dark") {
      d.dark = theme.colors;
    } else {
      d.light = theme.colors;
      if (theme.darkColors) d.dark = theme.darkColors;
    }
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d));
  } catch {}
}

// The machine's shared UI-preferences store. A bare localStorage.setItem on a
// shared key is clobbered by the next adopt() from the sync layer (the store
// snapshot overwrites the cache), so route the record through the host bridge.
// Live dragging fires many commits — the durable write is debounced to the
// store and the trailing re-setItem heals an adopt() of a stale snapshot.
var bridgeTimer = null;
var bridgeValue = null;
function persistUserThemeRecord(theme) {
  let ok = true;
  try {
    let record = {};
    try {
      record = JSON.parse(localStorage.getItem(USER_THEMES_KEY) || "{}") || {};
    } catch {}
    if (typeof record !== "object" || Array.isArray(record)) record = {};
    record[theme.name] = theme;
    const serialized = JSON.stringify(record);
    localStorage.setItem(USER_THEMES_KEY, serialized);
    const bridge = typeof window !== "undefined" && window.hermesDesktop && window.hermesDesktop.uiPreferences;
    if (bridge && typeof bridge.write === "function") {
      bridgeValue = serialized;
      if (!bridgeTimer) {
        bridgeTimer = setTimeout(() => {
          bridgeTimer = null;
          const value = bridgeValue;
          bridgeValue = null;
          if (!value) return;
          Promise.resolve(bridge.write({ values: { [USER_THEMES_KEY]: value } }))
            .then(() => {
              try {
                localStorage.setItem(USER_THEMES_KEY, value);
              } catch {}
            })
            .catch(() => {});
        }, 250);
      }
    }
  } catch {
    ok = false;
  }
  return ok;
}

function installCustom(theme) {
  let ok = true;
  try {
    persistUserThemeRecord(theme);
  } catch {
    ok = false;
  }
  try {
    // Re-registering the same contribution id replaces it (registry contract),
    // so requestTheme() resolves the fresh copy in-session even though the
    // app's $userThemes atom was initialized before this write.
    ctxRef.current.register({ id: "custom-theme", area: THEMES_AREA, data: theme });
  } catch {}
  return requestTheme(theme.name) && ok;
}

// Latest theme context seen by the picker, for palette commands that run
// outside React (revert needs the derived theme + resolved mode).
var liveRef = { current: null };

/** Clone the active theme with one slot recolored, and install it. */
function installSlotHex(theme, resolvedMode, key, hex) {
  const nextTheme = { ...theme };
  if (resolvedMode === "dark" && theme.darkColors) {
    nextTheme.darkColors = { ...theme.darkColors, [key]: hex };
  } else {
    nextTheme.colors = { ...theme.colors, [key]: hex };
  }
  nextTheme.name = OUR_NAME;
  nextTheme.label = "Custom (Accent Picker)";
  nextTheme.description = `Edited in Accent Picker+ (base: ${baseOf(theme)})`;
  nextTheme.accentOf = baseOf(theme);
  return installCustom(nextTheme);
}

/** Peek (without popping) the newest undo entry, optionally for one slot. */
function peekUndo(slotKey) {
  const list = readUndo();
  for (let i = list.length - 1; i >= 0; i--) {
    if (!slotKey || list[i].slot === slotKey) return list[i];
  }
  return null;
}

function isOurs(name) {
  return name === OUR_NAME || name.startsWith(OUR_NAME + "-");
}

/** The base theme a derived/custom theme branched from. */
function baseOf(src) {
  return isOurs(src.name) ? src.accentOf ?? baseName() : src.name;
}

// ── drag helper ──────────────────────────────────────────────────────────────

function useDrag(onMove, onEnd) {
  const ref = useRef(null);
  const moveRef = useRef(onMove);
  const endRef = useRef(onEnd);
  moveRef.current = onMove;
  endRef.current = onEnd;
  const onPointerDown = useCallback((event) => {
    const box = ref.current;
    if (!box) {
      return;
    }
    const emit = (clientX, clientY) => {
      const r = box.getBoundingClientRect();
      moveRef.current(clamp01((clientX - r.left) / r.width), clamp01((clientY - r.top) / r.height));
    };
    emit(event.clientX, event.clientY);
    const onPointerMove = (e) => emit(e.clientX, e.clientY);
    const stop = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stop);
      if (endRef.current) {
        endRef.current();
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stop);
  }, []);
  return { onPointerDown, ref };
}

// ── chroma/lightness field (gamut-clipped: always a full square) ─────────────

function ChromaLightnessField({ hue, lch, onPick, onEnd }) {
  const canvas = useRef(null);
  const drag = useDrag((x, y) => onPick(1 - y, x * CHROMA_MAX), onEnd);
  useEffect(() => {
    const el = canvas.current;
    if (!el) {
      return;
    }
    const ctx = el.getContext("2d");
    if (!ctx) {
      return;
    }
    const img = ctx.createImageData(FIELD_W, FIELD_H);
    for (let y = 0; y < FIELD_H; y += 1) {
      const l = 1 - y / (FIELD_H - 1);
      // Gamut-clip per row: beyond maxChroma the color leaves sRGB, and the
      // stock picker painted those pixels transparent (the broken wedge).
      // Clipping chroma keeps hue + lightness and fills the square.
      const cMax = maxChroma(l, hue);
      for (let x = 0; x < FIELD_W; x += 1) {
        const color = { l, c: Math.min((x / (FIELD_W - 1)) * CHROMA_MAX, cMax), h: hue };
        const rgb = oklchToSrgb255(color);
        const i = (y * FIELD_W + x) * 4;
        const out = rgb || hexToRgb255(oklchToHex(color));
        if (out) {
          img.data[i] = out[0];
          img.data[i + 1] = out[1];
          img.data[i + 2] = out[2];
          img.data[i + 3] = 255;
        } else {
          img.data[i + 3] = 0;
        }
      }
    }
    ctx.clearRect(0, 0, FIELD_W, FIELD_H);
    ctx.putImageData(img, 0, 0);
  }, [hue]);
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: "relative cursor-crosshair overflow-hidden rounded-sm",
      onPointerDown: drag.onPointerDown,
      ref: drag.ref,
      style: { height: FIELD_H, width: FIELD_W },
      children: [
        /* @__PURE__ */ jsx("canvas", { className: "block size-full", height: FIELD_H, ref: canvas, width: FIELD_W }),
        /* @__PURE__ */ jsx(
          "div",
          {
            className: "pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.6)]",
            style: { left: `${lch.c / CHROMA_MAX * 100}%`, top: `${(1 - lch.l) * 100}%` }
          }
        )
      ]
    }
  );
}

function HueRail({ lch, onPick, onEnd }) {
  const drag = useDrag((x) => onPick(x * 360), onEnd);
  const gradient = useMemo(() => {
    const stops = [];
    for (let i = 0; i <= 36; i += 1) {
      const h = i / 36 * 360;
      const c = Math.min(lch.c, maxChroma(lch.l, h));
      stops.push(`${oklchToHex({ l: lch.l, c, h })} ${i / 36 * 100}%`);
    }
    return `linear-gradient(to right, ${stops.join(", ")})`;
  }, [lch.l, lch.c]);
  return /* @__PURE__ */ jsx(
    "div",
    {
      className: "relative cursor-ew-resize rounded-full",
      onPointerDown: drag.onPointerDown,
      ref: drag.ref,
      style: { background: gradient, height: RAIL_H, width: FIELD_W },
      children: /* @__PURE__ */ jsx(
        "div",
        {
          className: "pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.6)]",
          style: { left: `${lch.h / 360 * 100}%` }
        }
      )
    }
  );
}

// ── palette slots ────────────────────────────────────────────────────────────

var SLOTS = [
  ["background", "Background"],
  ["foreground", "Foreground"],
  ["sidebarBackground", "Sidebar"],
  ["sidebarBorder", "Sidebar border"],
  ["card", "Card"],
  ["popover", "Popover"],
  ["muted", "Muted"],
  ["border", "Border"],
  ["input", "Input"],
  ["primary", "Primary (accent)"],
  ["secondary", "Secondary"],
  ["accent", "Accent soft"],
  ["userBubble", "User bubble"],
  ["destructive", "Destructive"]
];

function SlotEditor({ palette, slotKey, resolvedMode, onApply, onBack }) {
  const start = hexToOklch(palette[slotKey]) ?? { l: 0.5, c: 0.1, h: 260 };
  const lchRef = useRef(start);
  const [lch, setLch] = useState(start);
  const lastLive = useRef(0);
  const undoArmed = useRef(false);
  const update = (patch) => {
    lchRef.current = { ...lchRef.current, ...patch };
    setLch(lchRef.current);
  };
  // One undo entry per editing session: the color the slot had when the
  // editor opened. Armed right before the first commit of the session.
  const armUndo = () => {
    if (!undoArmed.current) {
      undoArmed.current = true;
      pushUndo({ slot: slotKey, mode: resolvedMode, prevHex: palette[slotKey] });
    }
  };
  const commit = (throttled) => {
    armUndo();
    const now = Date.now();
    // Live update while dragging, throttled so the theme install (record
    // write + registry swap + repaint) runs at most ~8x per second; the
    // final value is always committed on release.
    if (!throttled || now - lastLive.current > 120) {
      lastLive.current = now;
      onApply(slotKey, oklchToHex(lchRef.current));
    }
  };
  const defaults = readDefaults();
  const defaultHex = defaults ? (resolvedMode === "dark" ? (defaults.dark ?? defaults.light) : (defaults.light ?? defaults.dark))?.[slotKey] : null;
  const revertEntry = peekUndo(slotKey);
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-2 p-2", style: { width: FIELD_W + 16 }, children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-1.5", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          className: "shrink-0 rounded-sm border border-(--dt-border) px-1.5 py-0.5 text-[11px]",
          onClick: onBack,
          type: "button",
          children: "\u2190"
        }
      ),
      /* @__PURE__ */ jsx("span", { className: "min-w-0 flex-1 truncate text-[11px]", children: (SLOTS.find((s) => s[0] === slotKey) || [null, slotKey])[1] }),
      /* @__PURE__ */ jsx("span", { className: "size-5 shrink-0 rounded-sm border border-(--dt-border)", style: { background: palette[slotKey] } }),
      /* @__PURE__ */ jsx("span", { className: "font-mono text-[10px] text-(--ui-text-tertiary)", children: palette[slotKey] })
    ] }),
    /* @__PURE__ */ jsx(
      ChromaLightnessField,
      {
        hue: lch.h,
        lch,
        onEnd: () => commit(false),
        onPick: (l, c) => {
          update({ l, c });
          commit(true);
        }
      }
    ),
    /* @__PURE__ */ jsx(HueRail, { lch, onEnd: () => commit(false), onPick: (h) => { update({ h }); commit(true); } }),
    /* @__PURE__ */ jsxs("div", { className: "flex gap-1.5", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          className: "flex-1 rounded-sm border border-(--dt-border) px-1.5 py-0.5 text-[11px] hover:bg-(--chrome-action-hover)",
          onClick: () => { if (defaultHex) { armUndo(); onApply(slotKey, defaultHex); const l = hexToOklch(defaultHex) ?? start; lchRef.current = l; setLch(l); } },
          title: defaultHex ? `Base theme default: ${defaultHex}` : "No default captured",
          type: "button",
          children: "Reset to default"
        }
      ),
      /* @__PURE__ */ jsx(
        "button",
        {
          className: "flex-1 rounded-sm border border-(--dt-border) px-1.5 py-0.5 text-[11px] hover:bg-(--chrome-action-hover)",
          disabled: !revertEntry,
          onClick: () => { if (revertEntry) { armUndo(); onApply(slotKey, revertEntry.prevHex); const l = hexToOklch(revertEntry.prevHex) ?? start; lchRef.current = l; setLch(l); } },
          title: revertEntry ? `Back to ${revertEntry.prevHex}` : "Nothing to revert",
          type: "button",
          children: "Revert edit"
        }
      )
    ] }),
    /* @__PURE__ */ jsx("p", { className: "h-3 font-mono text-[10px] leading-tight text-(--ui-text-tertiary)", children: "live while you drag \xB7 saved with the theme" })
  ] });
}

// ── main picker ──────────────────────────────────────────────────────────────

function AccentPicker() {
  const { theme, renderedMode, resolvedMode } = useTheme();
  const override = useValue($accentOverride);
  const painted = theme.colors.primary;
  const [tab, setTab] = useState("accent");
  const [slot, setSlot] = useState(null);
  const [lch, setLch] = useState(() => hexToOklch(painted) ?? { l: 0.5, c: 0.15, h: 260 });
  const [text, setText] = useState(painted);
  const dragging = useRef(false);
  useEffect(() => {
    rememberBase(theme.name);
  }, [theme.name]);
  useEffect(() => {
    if (!dragging.current) {
      setLch(hexToOklch(painted) ?? { l: 0.5, c: 0.15, h: 260 });
      setText(painted);
    }
  }, [painted]);
  const commit = (next) => {
    dragging.current = true;
    setLch(next);
    const hex = oklchToHex(next);
    setText(hex);
    setAccentOverride(hex);
    requestAnimationFrame(() => {
      dragging.current = false;
    });
  };
  const surface = (renderedMode === "dark" ? theme.darkColors : theme.colors) ?? theme.colors;
  const ratio = contrastRatio(painted, surface.sidebarBackground ?? surface.background);
  const palette = (resolvedMode === "dark" ? theme.darkColors : theme.colors) ?? theme.colors;
  // Snapshot the base palettes the first time an edit branches off the base.
  useEffect(() => {
    liveRef.current = { theme, resolvedMode };
    if (!isOurs(theme.name)) captureDefaults(theme, resolvedMode);
  }, [theme, resolvedMode]);
  const saveAccent = () => {
    const hex = oklchToHex(lch);
    const next = {
      ...retintTheme(theme, hex),
      name: OUR_NAME,
      label: "Custom (Accent Picker)",
      description: `Saved from Accent Picker+ (base: ${baseOf(theme)})`,
      accentOf: baseOf(theme)
    };
    if (installCustom(next)) {
      setAccentOverride(null);
      notify("Accent saved as a theme \u2014 it survives restarts now.");
    } else {
      notify("Could not save the theme (storage write failed).");
    }
  };
  const onApply = (key, hex) => {
    if (installSlotHex(theme, resolvedMode, key, hex)) {
      notify(`${key} updated.`);
    } else {
      notify("Could not save (storage write failed).");
    }
  };
  const saved = isOurs(theme.name);
  if (tab === "colors" && slot) {
    return /* @__PURE__ */ jsx(SlotEditor, { onApply, onBack: () => setSlot(null), palette, resolvedMode, slotKey: slot });
  }
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-2 p-2", style: { width: FIELD_W + 16 }, children: [
    /* @__PURE__ */ jsxs("div", { className: "flex gap-1", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          className: tab === "accent" ? "flex-1 rounded-sm border border-(--dt-border) bg-(--chrome-action-hover) px-1.5 py-0.5 text-[11px]" : "flex-1 rounded-sm border border-(--dt-border) px-1.5 py-0.5 text-[11px]",
          onClick: () => setTab("accent"),
          type: "button",
          children: "Accent"
        }
      ),
      /* @__PURE__ */ jsx(
        "button",
        {
          className: tab === "colors" ? "flex-1 rounded-sm border border-(--dt-border) bg-(--chrome-action-hover) px-1.5 py-0.5 text-[11px]" : "flex-1 rounded-sm border border-(--dt-border) px-1.5 py-0.5 text-[11px]",
          onClick: () => setTab("colors"),
          type: "button",
          children: "Colors"
        }
      )
    ] }),
    tab === "accent" ? /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx(ChromaLightnessField, { hue: lch.h, lch, onPick: (l, c) => commit({ ...lch, c, l }) }),
      /* @__PURE__ */ jsx(HueRail, { lch, onPick: (h) => commit({ ...lch, h }) }),
      /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-1.5", children: [
        /* @__PURE__ */ jsx("span", { className: "size-5 shrink-0 rounded-sm border border-(--dt-border)", style: { background: painted } }),
        /* @__PURE__ */ jsx(
          "input",
          {
            className: "min-w-0 flex-1 rounded-sm border border-(--dt-border) bg-transparent px-1.5 py-0.5 font-mono text-[11px] uppercase",
            onChange: (event) => {
              setText(event.target.value);
              setAccentOverride(event.target.value);
            },
            spellCheck: false,
            value: text
          }
        ),
        /* @__PURE__ */ jsx(
          "button",
          {
            className: "shrink-0 rounded-sm border border-(--dt-border) px-1.5 py-0.5 text-[11px]",
            onClick: () => setAccentOverride(null),
            title: "Clear the live preview",
            type: "button",
            children: "reset"
          }
        )
      ] }),
      /* @__PURE__ */ jsx("div", { className: "grid grid-cols-8 gap-1", children: SWATCHES.map((swatch) => /* @__PURE__ */ jsx(
        "button",
        {
          className: "size-5 rounded-sm border border-(--dt-border)",
          onClick: () => setAccentOverride(swatch.hex),
          style: { background: swatch.hex },
          title: `${swatch.name} \xB7 ${swatch.hex}`,
          type: "button"
        },
        swatch.hex
      )) }),
      /* @__PURE__ */ jsx(
        "button",
        {
          className: "w-full rounded-sm border border-(--dt-border) px-1.5 py-1 text-[11px] hover:bg-(--chrome-action-hover)",
          onClick: saveAccent,
          type: "button",
          children: saved ? "Re-save theme with this accent" : "Save as theme (persists across restarts)"
        }
      ),
      /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between font-mono text-[10px] tabular-nums text-(--ui-text-tertiary)", children: [
        /* @__PURE__ */ jsxs("span", { children: [
          "H",
          /* @__PURE__ */ jsx("span", { className: "inline-block w-[3ch] text-right", children: Math.round(lch.h) }),
          " L",
          lch.l.toFixed(2),
          " C",
          lch.c.toFixed(3)
        ] }),
        /* @__PURE__ */ jsxs("span", { className: ratio >= 4.5 ? "" : "text-(--dt-destructive)", children: [
          renderedMode,
          " ",
          ratio.toFixed(1),
          ":1"
        ] })
      ] }),
      /* @__PURE__ */ jsx("p", { className: "h-3 font-mono text-[10px] leading-tight text-(--ui-text-tertiary)", children: saved ? "theme saved \u2014 active across restarts" : override && override.toLowerCase() !== painted.toLowerCase() ? `previewing ${override} \u2192 not saved yet` : "\xA0" })
    ] }) : /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-1", children: [
      SLOTS.filter((s) => typeof palette[s[0]] === "string").map((s) => /* @__PURE__ */ jsxs(
        "button",
        {
          className: "flex items-center gap-1.5 rounded-sm border border-(--dt-border) px-1.5 py-1 text-left text-[11px] hover:bg-(--chrome-action-hover)",
          onClick: () => setSlot(s[0]),
          type: "button",
          children: [
            /* @__PURE__ */ jsx("span", { className: "min-w-0 flex-1 truncate", children: s[1] }),
            /* @__PURE__ */ jsx("span", { className: "font-mono text-[10px] text-(--ui-text-tertiary)", children: palette[s[0]] }),
            /* @__PURE__ */ jsx("span", { className: "size-4 shrink-0 rounded-sm border border-(--dt-border)", style: { background: palette[s[0]] } })
          ]
        },
        s[0]
      )),
      /* @__PURE__ */ jsx(
        "button",
        {
          className: "w-full rounded-sm border border-(--dt-border) px-1.5 py-1 text-[11px] hover:bg-(--chrome-action-hover)",
          onClick: () => {
            setAccentOverride(null);
            restoreBase();
          },
          type: "button",
          children: "Restore base theme"
        }
      ),
      /* @__PURE__ */ jsx("p", { className: "h-3 font-mono text-[10px] leading-tight text-(--ui-text-tertiary)", children: `${resolvedMode} palette \xB7 edits save into the theme` })
    ] })
  ] });
}

function AccentPickerTrigger() {
  const { theme } = useTheme();
  useEffect(() => {
    rememberBase(theme.name);
  }, [theme.name]);
  return /* @__PURE__ */ jsxs(Popover, { children: [
    /* @__PURE__ */ jsx(PopoverTrigger, { asChild: true, children: /* @__PURE__ */ jsxs(
      "button",
      {
        className: "inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground",
        title: "Accent color + palette editor",
        type: "button",
        children: [
          /* @__PURE__ */ jsx(
            "span",
            {
              className: "size-2.5 shrink-0 rounded-full border border-(--dt-border)",
              style: { background: theme.colors.primary }
            }
          ),
          /* @__PURE__ */ jsx("span", { className: "text-center font-mono tabular-nums", style: { width: `${HEX_CH}ch` }, children: theme.colors.primary })
        ]
      }
    ) }),
    /* @__PURE__ */ jsx(PopoverContent, { align: "end", className: "w-auto p-0", side: "top", children: /* @__PURE__ */ jsx(AccentPicker, {}) })
  ] });
}

var plugin = {
  id: "accent",
  name: "Accent Picker+",
  description: "OKLCH accent picker that can SAVE the accent as a real theme (survives restarts) and recolor every palette slot (sidebar, card, popover, ...).",
  defaultEnabled: false,
  register(ctx) {
    ctxRef.current = ctx;
    ctx.onDispose(() => setAccentOverride(null));
    ctx.registerMany([
      {
        id: "picker",
        area: STATUSBAR_AREAS.right,
        order: 90,
        render: () => /* @__PURE__ */ jsx(AccentPickerTrigger, {})
      },
      {
        id: "reset",
        area: PALETTE_AREA,
        data: {
          id: "accent.reset",
          label: "Accent: reset to the theme default",
          keywords: ["accent", "color", "theme", "reset", "default"],
          run: () => setAccentOverride(null)
        }
      },
      {
        id: "basetheme",
        area: PALETTE_AREA,
        data: {
          id: "accent.base",
          label: "Accent+: switch back to the base theme",
          keywords: ["accent", "theme", "base", "restore", "custom"],
          run: () => {
            setAccentOverride(null);
            if (!restoreBase()) {
              notify(`Base theme "${baseName()}" not found.`);
            }
          }
        }
      },
      {
        id: "revertEdit",
        area: PALETTE_AREA,
        data: {
          id: "accent.revert",
          label: "Accent+: revert the last color edit",
          keywords: ["accent", "revert", "undo", "color", "slot"],
          run: () => {
            const entry = popUndo(null);
            if (!entry) {
              notify("Nothing to revert.");
              return;
            }
            const live = liveRef.current;
            if (!live || !live.theme) {
              notify("No theme context.");
              return;
            }
            if (installSlotHex(live.theme, live.resolvedMode, entry.slot, entry.prevHex)) {
              notify(`Reverted ${entry.slot} to ${entry.prevHex}.`);
            }
          }
        }
      },
      {
        id: "copy",
        area: PALETTE_AREA,
        data: {
          id: "accent.copy",
          label: "Accent: copy the current color",
          keywords: ["accent", "color", "hex", "copy", "clipboard"],
          run: () => {
            const hex = $accentOverride.get();
            if (hex) {
              void navigator.clipboard?.writeText(hex);
            }
          }
        }
      }
    ]);
  }
};
var plugin_default = plugin;
export {
  plugin_default as default
};

// touched 1793213868
