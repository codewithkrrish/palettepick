// PalettePick engine — pure colour logic, no DOM anywhere in this file.
// It runs identically in the browser (as an ES module) and in Node (for the
// test harness), so everything here is unit-testable without a page.
//
// The extraction itself is a hand-written median-cut quantiser over a
// downscaled copy of the image. There is no model, no network call and no
// "AI" involved — the word is deliberately absent from this whole project.

export const SITE_URL = "https://palettepick-app.vercel.app/";
export const MAX_IMAGES = 8;
export const MAX_RECENT_PALETTES = 10;
export const MIN_COLOR_COUNT = 3;
export const MAX_COLOR_COUNT = 10;

export const SAMPLE_IMAGES = [
  { id: "sunset", name: "Sunset glow", stops: ["#2B1055", "#E5484D", "#F59E0B", "#FDE68A"] },
  { id: "ocean", name: "Deep ocean", stops: ["#082F49", "#0369A1", "#38BDF8", "#A5F3FC"] },
  { id: "forest", name: "Forest floor", stops: ["#14532D", "#22C55E", "#A3E635", "#FEF9C3"] },
  { id: "berry", name: "Berry dusk", stops: ["#4C0519", "#BE123C", "#F472B6", "#FBCFE8"] },
  { id: "desert", name: "Desert noon", stops: ["#451A03", "#B45309", "#F59E0B", "#FEF3C7"] },
  { id: "slate", name: "Slate study", stops: ["#0B0B0F", "#3F3F46", "#9A9AA5", "#F5F5F7"] },
];

// ---------------------------------------------------------------------------
// Basic conversions
// ---------------------------------------------------------------------------

export function clampByte(value) {
  const n = Math.round(Number(value));
  if (Number.isNaN(n)) return 0;
  return Math.min(255, Math.max(0, n));
}

export function clamp01(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** {r,g,b} (0-255) -> "#E5484D" (uppercase, always 6 digits). */
export function rgbToHex(r, g, b) {
  const part = (v) => clampByte(v).toString(16).padStart(2, "0").toUpperCase();
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** "#E5484D", "#e5484d", "E5484D" or "#E54" -> {r,g,b}, or null if unparsable. */
export function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  let h = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    h = h.split("").map((c) => c + c).join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** {r,g,b} (0-255) -> {h: 0-360, s: 0-100, l: 0-100}, rounded to 1 decimal. */
export function rgbToHsl(r, g, b) {
  const rn = clampByte(r) / 255;
  const gn = clampByte(g) / 255;
  const bn = clampByte(b) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === rn) h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / delta + 2) * 60;
    else h = ((rn - gn) / delta + 4) * 60;
  }
  return {
    h: Math.round(((h % 360) + 360) % 360 * 10) / 10,
    s: Math.round(s * 1000) / 10,
    l: Math.round(l * 1000) / 10,
  };
}

/** {h: 0-360, s: 0-100, l: 0-100} -> {r,g,b} (0-255 integers). */
export function hslToRgb(h, s, l) {
  const hn = (((Number(h) % 360) + 360) % 360) / 360;
  const sn = clamp01(Number(s) / 100);
  const ln = clamp01(Number(l) / 100);
  if (sn === 0) {
    const v = clampByte(ln * 255);
    return { r: v, g: v, b: v };
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const channel = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: clampByte(channel(hn + 1 / 3) * 255),
    g: clampByte(channel(hn) * 255),
    b: clampByte(channel(hn - 1 / 3) * 255),
  };
}

/** Build one canonical colour object from RGB channels. */
export function toColor(r, g, b, extra = {}) {
  const rr = clampByte(r);
  const gg = clampByte(g);
  const bb = clampByte(b);
  const { h, s, l } = rgbToHsl(rr, gg, bb);
  return { r: rr, g: gg, b: bb, hex: rgbToHex(rr, gg, bb), h, s, l, ...extra };
}

export function colorFromHex(hex, extra = {}) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return toColor(rgb.r, rgb.g, rgb.b, extra);
}

export function formatRgb(color) {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

export function formatHsl(color) {
  return `hsl(${Math.round(color.h)}, ${Math.round(color.s)}%, ${Math.round(color.l)}%)`;
}

// ---------------------------------------------------------------------------
// Light, contrast and filtering helpers
// ---------------------------------------------------------------------------

/** Relative luminance (WCAG 2.1), 0 for black, 1 for white. */
export function relativeLuminance(color) {
  const linear = (c) => {
    const v = clampByte(c) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** WCAG contrast ratio between two colours, 1 (same) to 21 (black/white). */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Readable text colour to put on top of a swatch: white or near-black. */
export function bestTextColor(color) {
  return contrastRatio(color, { r: 255, g: 255, b: 255 }) >=
    contrastRatio(color, { r: 11, g: 11, b: 15 })
    ? "#FFFFFF"
    : "#0B0B0F";
}

export function isNearWhite(color) {
  return color.r > 245 && color.g > 245 && color.b > 245;
}

export function isNearBlack(color) {
  return color.r < 8 && color.g < 8 && color.b < 8;
}

export function saturationOf(color) {
  return rgbToHsl(color.r, color.g, color.b).s;
}

// ---------------------------------------------------------------------------
// Median-cut palette extraction
// ---------------------------------------------------------------------------

function normalisePixels(pixels) {
  // Accept either a flat RGBA array (Uint8ClampedArray / number[]) or a list
  // of {r,g,b} objects / [r,g,b] triples.
  if (!pixels || pixels.length === 0) return [];
  const first = pixels[0];
  if (typeof first === "number") {
    const out = [];
    for (let i = 0; i + 2 < pixels.length; i += 4) {
      out.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
    }
    return out;
  }
  return pixels.map((p) =>
    Array.isArray(p) ? [p[0], p[1], p[2]] : [p.r, p.g, p.b],
  );
}

function channelRange(box, channel) {
  let min = 255;
  let max = 0;
  for (const px of box) {
    if (px[channel] < min) min = px[channel];
    if (px[channel] > max) max = px[channel];
  }
  return max - min;
}

function medianCutBoxes(pixels, targetCount) {
  let boxes = [pixels];
  while (boxes.length < targetCount) {
    let bestIndex = -1;
    let bestRange = 0;
    let bestChannel = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      for (let c = 0; c < 3; c++) {
        const range = channelRange(box, c);
        if (range > bestRange) {
          bestRange = range;
          bestIndex = i;
          bestChannel = c;
        }
      }
    }
    if (bestIndex === -1 || bestRange === 0) break; // nothing left to split
    const box = boxes[bestIndex];
    const sorted = [...box].sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = Math.floor(sorted.length / 2);
    const left = sorted.slice(0, mid);
    const right = sorted.slice(mid);
    if (left.length === 0 || right.length === 0) break;
    boxes.splice(bestIndex, 1, left, right);
  }
  return boxes;
}

/**
 * Extract the dominant colours from raw pixel data.
 *
 * pixels: flat RGBA array (as from getImageData().data) or a list of
 * {r,g,b} / [r,g,b] colours. width/height are informational (used only for
 * the share calculation when a flat array is passed without them — pass them
 * when you have them).
 *
 * options:
 *   count            — how many colours to return (3-10, default 6)
 *   sampleStep       — take every Nth pixel: 1 = precise, 2 = balanced,
 *                      4+ = fast. Default 2.
 *   excludeExtremes  — drop near-white and near-black pixels first
 *                      (default true; a photo's white border shouldn't win)
 *   satFloor         — drop colours less saturated than this (0-100,
 *                      default 0 = keep everything)
 *
 * Returns [{r,g,b,hex,h,s,l,count,share}] ordered most-frequent first.
 * Fewer colours come back than requested when the image simply doesn't
 * have that many distinct colours — that is correct, not an error.
 */
export function extractPalette(pixels, width, height, options = {}) {
  const count = Math.min(
    MAX_COLOR_COUNT,
    Math.max(1, Math.round(options.count ?? 6)),
  );
  const sampleStep = Math.max(1, Math.round(options.sampleStep ?? 2));
  const excludeExtremes = options.excludeExtremes !== false;
  const satFloor = Math.min(100, Math.max(0, Number(options.satFloor ?? 0)));

  let all = normalisePixels(pixels);
  if (all.length === 0) return [];

  // Sampling: walk the pixel list with the requested stride. This is the
  // speed/quality knob — a 240px-wide downscaled image at step 2 is ~14k
  // pixels, which median-cut chews through instantly.
  const sampled = [];
  for (let i = 0; i < all.length; i += sampleStep) sampled.push(all[i]);

  const keep = (px) => {
    const c = { r: px[0], g: px[1], b: px[2] };
    if (excludeExtremes && (isNearWhite(c) || isNearBlack(c))) return false;
    if (satFloor > 0 && saturationOf(c) < satFloor) return false;
    return true;
  };
  let usable = sampled.filter(keep);
  // If the filters ate everything (e.g. a pure black-and-white photo with
  // extremes excluded), fall back to the unfiltered set rather than
  // returning nothing — an empty palette helps nobody.
  if (usable.length === 0) usable = sampled;

  const boxes = medianCutBoxes(usable, count);
  const merged = new Map();
  for (const box of boxes) {
    if (box.length === 0) continue;
    // The representative colour is the MODE of the box — the exact RGB
    // value that occurs most often — not the mean. Two reasons: a flat
    // area of one colour must come back as exactly that colour (a mean
    // drifts by a point or two when a browser's decode/draw pipeline
    // leaves a few ±1 neighbour pixels around, e.g. #FE0001 for a pure
    // red image), and a swatch that names a colour actually present in
    // the photo is more honest than an averaged colour that appears
    // nowhere in it. On a tie (a smooth gradient where every value
    // occurs once) fall back to the pixel nearest the box mean.
    let r = 0;
    let g = 0;
    let b = 0;
    for (const px of box) {
      r += px[0];
      g += px[1];
      b += px[2];
    }
    const mean = [r / box.length, g / box.length, b / box.length];
    const freq = new Map();
    for (const px of box) {
      const key = (px[0] << 16) | (px[1] << 8) | px[2];
      freq.set(key, (freq.get(key) || 0) + 1);
    }
    let bestKey = -1;
    let bestCount = -1;
    let bestDist = Infinity;
    for (const [key, n] of freq) {
      const pr = (key >> 16) & 0xff;
      const pg = (key >> 8) & 0xff;
      const pb = key & 0xff;
      const dist =
        (pr - mean[0]) ** 2 + (pg - mean[1]) ** 2 + (pb - mean[2]) ** 2;
      if (n > bestCount || (n === bestCount && dist < bestDist)) {
        bestKey = key;
        bestCount = n;
        bestDist = dist;
      }
    }
    const [sr, sg, sb] = snapNearPure(
      (bestKey >> 16) & 0xff,
      (bestKey >> 8) & 0xff,
      bestKey & 0xff,
    );
    const colour = toColor(sr, sg, sb);
    const existing = merged.get(colour.hex);
    if (existing) {
      existing.count += box.length;
    } else {
      merged.set(colour.hex, { ...colour, count: box.length });
    }
  }

  const total = usable.length;
  const palette = [...merged.values()].map((c) => ({
    ...c,
    share: Math.round((c.count / total) * 1000) / 10,
  }));
  // Most frequent first; hex as a deterministic tie-break so the same
  // image always produces the same order.
  palette.sort((a, b) => b.count - a.count || (a.hex < b.hex ? -1 : 1));
  return palette.slice(0, count);
}

/** Convenience wrapper for an ImageData-like object {data, width, height}. */
/**
 * Snap a colour to the pure value when it is already essentially pure:
 * every channel within 2 steps of 0 or 255. Browsers dither pure colours
 * by ±1 when an image passes through their canvas pipeline (a flat red
 * PNG can read back as (254,0,1) or (255,1,1) depending on the pixel's
 * position), so without this a flat red logo extracts as #FE0001 instead
 * of #FF0000. The all-three-channels rule keeps the snap conservative:
 * a real photo colour like (250,30,40) is untouched because its green
 * channel is nowhere near an extreme.
 */
export function snapNearPure(r, g, b) {
  const snap = (v) => (v <= 2 ? 0 : v >= 253 ? 255 : v);
  const near = (v) => v <= 2 || v >= 253;
  if (near(r) && near(g) && near(b)) return [snap(r), snap(g), snap(b)];
  return [r, g, b];
}

export function extractPaletteFromImageData(imageData, options = {}) {
  if (!imageData || !imageData.data) return [];
  return extractPalette(
    imageData.data,
    imageData.width,
    imageData.height,
    options,
  );
}

// ---------------------------------------------------------------------------
// Colour harmonies
// ---------------------------------------------------------------------------

/** The same colour with its hue rotated by `degrees` (wraps at 360). */
export function shiftHue(color, degrees) {
  const { h, s, l } = rgbToHsl(color.r, color.g, color.b);
  const shifted = hslToRgb(((h + degrees) % 360 + 360) % 360, s, l);
  return toColor(shifted.r, shifted.g, shifted.b);
}

export function harmonyComplementary(color) {
  return [shiftHue(color, 180)];
}

export function harmonyAnalogous(color) {
  return [shiftHue(color, -30), shiftHue(color, 30)];
}

export function harmonyTriadic(color) {
  return [shiftHue(color, 120), shiftHue(color, 240)];
}

export function harmonySplitComplementary(color) {
  return [shiftHue(color, 150), shiftHue(color, 210)];
}

/**
 * All four harmony rows for a base colour. Every row includes the base
 * colour itself so each row reads as a usable scheme, not a fragment.
 * Returns { complementary, analogous, triadic, splitComplementary }.
 */
export function harmoniesFor(color) {
  const base = toColor(color.r, color.g, color.b);
  return {
    complementary: [base, ...harmonyComplementary(base)],
    analogous: [shiftHue(base, -30), base, shiftHue(base, 30)],
    triadic: [base, ...harmonyTriadic(base)],
    splitComplementary: [base, ...harmonySplitComplementary(base)],
  };
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * mode: "frequency" (most common first, the extraction order),
 * "luminance" (lightest first), "hue" (0-360), "saturation" (most
 * saturated first). Returns a new array; the input is untouched.
 */
export function sortPalette(palette, mode = "frequency") {
  const copy = [...palette];
  switch (mode) {
    case "luminance":
      return copy.sort(
        (a, b) => relativeLuminance(b) - relativeLuminance(a),
      );
    case "hue":
      return copy.sort((a, b) => a.h - b.h);
    case "saturation":
      return copy.sort((a, b) => b.s - a.s);
    case "frequency":
    default:
      return copy.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  }
}

// ---------------------------------------------------------------------------
// Export builders (plain text — the UI just copies or downloads these)
// ---------------------------------------------------------------------------

export function buildCssVariables(palette, prefix = "--color") {
  const lines = palette.map((c, i) => `  ${prefix}-${i + 1}: ${c.hex};`);
  return `:root {\n${lines.join("\n")}\n}`;
}

export function buildTailwindConfig(palette, name = "palette") {
  const lines = palette.map((c, i) => `          ${i + 1}: '${c.hex}',`);
  return [
    "module.exports = {",
    "  theme: {",
    "    extend: {",
    "      colors: {",
    `        ${name}: {`,
    ...lines,
    "        },",
    "      },",
    "    },",
    "  },",
    "};",
  ].join("\n");
}

export function buildPaletteJson(palette, meta = {}) {
  const doc = {
    name: meta.name || "PalettePick palette",
    source: meta.source || "image",
    createdAt: meta.createdAt || new Date().toISOString(),
    site: SITE_URL,
    colors: palette.map((c) => ({
      hex: c.hex,
      rgb: { r: c.r, g: c.g, b: c.b },
      hsl: {
        h: Math.round(c.h),
        s: Math.round(c.s),
        l: Math.round(c.l),
      },
      share: c.share,
    })),
  };
  return JSON.stringify(doc, null, 2);
}

export function buildHexList(palette) {
  return palette.map((c) => c.hex).join(", ");
}

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

export function sanitizeFilename(name) {
  return String(name || "palette")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "palette";
}

export function dateStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

export function paletteFilename(baseName, extension, date = new Date()) {
  return `palettepick-${sanitizeFilename(baseName)}-${dateStamp(date)}.${extension}`;
}
