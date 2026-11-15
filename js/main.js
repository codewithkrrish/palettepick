// PalettePick — DOM wiring only. All colour maths lives in engine.js.
// This file is deliberately boring: read controls, call the engine, paint
// the results. Anything testable lives in the engine; anything here is
// just plumbing, which is why the harness drives it through the exported
// functions below instead of re-implementing the flow.
import {
  SITE_URL,
  MAX_IMAGES,
  MAX_RECENT_PALETTES,
  SAMPLE_IMAGES,
  MIN_COLOR_COUNT,
  MAX_COLOR_COUNT,
  hexToRgb,
  toColor,
  colorFromHex,
  formatRgb,
  formatHsl,
  bestTextColor,
  extractPaletteFromImageData,
  harmoniesFor,
  sortPalette,
  buildCssVariables,
  buildTailwindConfig,
  buildPaletteJson,
  buildHexList,
  paletteFilename,
} from "./engine.js";

const $ = (id) => document.getElementById(id);
const RECENTS_KEY = "palettepick-recents";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const EXTRACT_MAX_DIMENSION = 240;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];

const state = {
  images: [], // { name, dataUrl, imageData, width, height }
  currentIndex: -1,
  palette: [],
  locked: new Set(), // hex strings pinned across re-extractions
  harmonyBase: null,
  sortMode: "frequency",
  recents: [],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

let toastTimer = null;
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2000);
}

async function copyText(text, message) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Older browsers: the invisible-textarea dance. Still local, still
      // no network — just a less elegant clipboard.
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    showToast(message || `Copied ${text}`);
    return true;
  } catch (err) {
    showToast("Copy failed — select the text and copy it manually.");
    return false;
  }
}

function downloadBlob(blob, filename) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  } catch (err) {
    showToast("Download failed in this browser — try copying instead.");
    return false;
  }
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Private mode / full storage: recents are a nicety, not the tool.
  }
}

// ---------------------------------------------------------------------------
// Image intake
// ---------------------------------------------------------------------------

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!ACCEPTED_TYPES.includes(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name || "")) {
      reject(new Error("That file is not a PNG, JPG or WebP image."));
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      reject(new Error("That image is over the 10 MB limit."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => {
        try {
          const entry = imageDataFromImage(img, file.name);
          entry.dataUrl = dataUrl;
          resolve(entry);
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error("That file could not be opened as an image."));
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

function imageDataFromImage(img, name) {
  const canvas = document.createElement("canvas");
  const scale = Math.min(
    1,
    EXTRACT_MAX_DIMENSION / Math.max(img.naturalWidth || 1, img.naturalHeight || 1),
  );
  const width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
  const height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available in this browser.");
  // No smoothing: when the image is downscaled for extraction, a
  // smoothed draw blends neighbouring colours into each other, which
  // is what turns flat #FF0000 into #FE0001.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return { name: name || "Untitled image", dataUrl: "", imageData, width, height };
}

/** Build pixel data for a built-in sample: a horizontal gradient through
 *  the stops with a gentle vertical brightness change, so the extraction
 *  finds the stop colours plus a few in-between shades. No photos are
 *  bundled with the repo — samples are pure maths. */
export function buildSamplePixels(sample, width = 160, height = 100) {
  const stops = sample.stops.map((hex) => hexToRgb(hex)).filter(Boolean);
  const data = new Uint8ClampedArray(width * height * 4);
  const lerp = (a, b, t) => Math.round(a + (b - a) * t);
  for (let y = 0; y < height; y++) {
    // Slight vertical lightening gives the gradient some depth to chew on.
    const bright = 0.92 + 0.16 * (y / Math.max(1, height - 1));
    for (let x = 0; x < width; x++) {
      const t = width === 1 ? 0 : x / (width - 1);
      const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
      const local = t * (stops.length - 1) - seg;
      const a = stops[seg];
      const b = stops[seg + 1];
      const i = (y * width + x) * 4;
      data[i] = Math.min(255, Math.round(lerp(a.r, b.r, local) * bright));
      data[i + 1] = Math.min(255, Math.round(lerp(a.g, b.g, local) * bright));
      data[i + 2] = Math.min(255, Math.round(lerp(a.b, b.b, local) * bright));
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/** An SVG gradient as a data URL, so the sample has something to show in
 *  the preview without bundling a photo. */
function samplePreviewUrl(sample) {
  const stops = sample.stops
    .map((hex, i) => {
      const offset = Math.round((i / (sample.stops.length - 1)) * 100);
      return `<stop offset="${offset}%" stop-color="${hex}"/>`;
    })
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient></defs>` +
    `<rect width="640" height="400" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function loadSample(id) {
  const sample = SAMPLE_IMAGES.find((s) => s.id === id) || SAMPLE_IMAGES[0];
  const pixels = buildSamplePixels(sample);
  const entry = {
    name: `Sample — ${sample.name}`,
    dataUrl: samplePreviewUrl(sample),
    imageData: pixels,
    width: pixels.width,
    height: pixels.height,
  };
  addImage(entry);
  return entry;
}

/** Feed raw pixels straight into the pipeline (used by the test harness
 *  and by the sample loader's callers). */
export function loadPixels(pixels, width, height, name = "Test image") {
  const entry = {
    name,
    dataUrl: "",
    imageData: { data: pixels, width, height },
    width,
    height,
  };
  addImage(entry);
  return entry;
}

export async function loadImageFile(file) {
  try {
    const entry = await readImageFile(file);
    addImage(entry);
    return entry;
  } catch (err) {
    showToast(err.message || "Could not load that image.");
    return null;
  }
}

function addImage(entry) {
  state.images.push(entry);
  if (state.images.length > MAX_IMAGES) {
    state.images.shift();
    showToast(`Kept the newest ${MAX_IMAGES} images — the oldest was removed.`);
  }
  state.currentIndex = state.images.length - 1;
  state.locked.clear();
  renderThumbs();
  renderSource();
  extractCurrent();
}

function switchImage(index) {
  if (index < 0 || index >= state.images.length) return;
  state.currentIndex = index;
  state.locked.clear();
  renderThumbs();
  renderSource();
  extractCurrent();
}

function removeImage(index) {
  state.images.splice(index, 1);
  if (state.images.length === 0) {
    state.currentIndex = -1;
    state.palette = [];
    state.harmonyBase = null;
    renderThumbs();
    renderSource();
    renderPalette();
    renderHarmonies();
    return;
  }
  state.currentIndex = Math.min(state.currentIndex, state.images.length - 1);
  state.locked.clear();
  renderThumbs();
  renderSource();
  extractCurrent();
}

function currentImage() {
  return state.images[state.currentIndex] || null;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function readControls() {
  return {
    count: Math.min(
      MAX_COLOR_COUNT,
      Math.max(MIN_COLOR_COUNT, Number($("color-count").value) || 6),
    ),
    sampleStep: Number($("quality-select").value) || 2,
    excludeExtremes: $("exclude-extremes").checked,
    satFloor: Number($("sat-floor").value) || 0,
  };
}

export function extractCurrent() {
  const image = currentImage();
  if (!image) {
    state.palette = [];
    renderPalette();
    renderHarmonies();
    return [];
  }
  const controls = readControls();
  const lockedColours = [...state.locked]
    .map((hex) => colorFromHex(hex))
    .filter(Boolean);
  const freshCount = Math.max(0, controls.count - lockedColours.length);
  let fresh = [];
  if (freshCount > 0) {
    fresh = extractPaletteFromImageData(image.imageData, {
      count: Math.max(freshCount, 1),
      sampleStep: controls.sampleStep,
      excludeExtremes: controls.excludeExtremes,
      satFloor: controls.satFloor,
    }).filter((c) => !state.locked.has(c.hex));
  }
  // Locked colours keep their place at the front; the rest is the fresh
  // extraction, sorted by whatever the sort control says. For frequency
  // sort the locked colours stay pinned first on purpose: a locked colour
  // has no pixel count (it came from a HEX string, not the image), so a
  // plain frequency sort would demote it to the back for having count 0.
  const combined = [...lockedColours, ...fresh].slice(0, controls.count);
  state.palette =
    state.sortMode === "frequency"
      ? [...lockedColours, ...sortPalette(fresh, "frequency")].slice(0, controls.count)
      : sortPalette(combined, state.sortMode);
  if (!state.harmonyBase || !state.palette.some((c) => c.hex === state.harmonyBase.hex)) {
    state.harmonyBase = state.palette[0] || null;
  }
  renderPalette();
  renderHarmonies();
  saveRecent(image.name);
  return state.palette;
}

export function setColorCount(n) {
  $("color-count").value = String(n);
  $("color-count-value").textContent = String(n);
  return extractCurrent();
}

export function setSort(mode) {
  state.sortMode = mode;
  $("sort-select").value = mode;
  state.palette = sortPalette(state.palette, mode);
  renderPalette();
  return state.palette;
}

export function setHarmonyBase(hex) {
  const colour = colorFromHex(hex);
  if (!colour) return null;
  state.harmonyBase = colour;
  renderPalette();
  renderHarmonies();
  return colour;
}

/** Pick the colour at pixel (x, y) of the current image (used by the
 *  click-on-preview handler). Returns the colour or null. Reads a 3x3
 *  neighbourhood and returns its most frequent colour (centre pixel on
 *  a tie): a single clicked pixel can sit on a ±1 decode artefact, but
 *  the colour the eye actually sees in a flat area is the neighbourhood
 *  mode — and the panel promises "that exact colour". */
export function pickColorAt(x, y) {
  const image = currentImage();
  if (!image) return null;
  const cx = Math.min(image.width - 1, Math.max(0, Math.floor(x)));
  const cy = Math.min(image.height - 1, Math.max(0, Math.floor(y)));
  const d = image.imageData.data;
  const freq = new Map();
  let centre = null;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const px = Math.min(image.width - 1, Math.max(0, cx + dx));
      const py = Math.min(image.height - 1, Math.max(0, cy + dy));
      const i = (py * image.width + px) * 4;
      const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      freq.set(key, (freq.get(key) || 0) + 1);
      if (dx === 0 && dy === 0) centre = key;
    }
  }
  let bestKey = centre;
  let bestCount = -1;
  for (const [key, n] of freq) {
    if (n > bestCount || (n === bestCount && key === centre)) {
      bestKey = key;
      bestCount = n;
    }
  }
  const colour = toColor(
    (bestKey >> 16) & 0xff,
    (bestKey >> 8) & 0xff,
    bestKey & 0xff,
  );
  state.harmonyBase = colour;
  renderPalette();
  renderHarmonies();
  showToast(`Picked ${colour.hex} — harmonies updated below.`);
  return colour;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderThumbs() {
  const strip = $("thumb-strip");
  strip.innerHTML = "";
  state.images.forEach((img, i) => {
    const wrap = document.createElement("span");
    wrap.className = "thumb-wrap";
    const thumb = document.createElement("img");
    thumb.className = "thumb" + (i === state.currentIndex ? " active" : "");
    thumb.src = img.dataUrl || samplePreviewUrl(SAMPLE_IMAGES[0]);
    thumb.alt = img.name;
    thumb.title = img.name;
    thumb.addEventListener("click", () => switchImage(i));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "thumb-remove";
    remove.textContent = "×";
    remove.title = `Remove ${img.name}`;
    remove.setAttribute("aria-label", `Remove ${img.name}`);
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      removeImage(i);
    });
    wrap.appendChild(thumb);
    wrap.appendChild(remove);
    strip.appendChild(wrap);
  });
}

function renderSource() {
  const image = currentImage();
  const img = $("source-img");
  const empty = $("source-empty");
  const meta = $("source-meta");
  if (!image) {
    img.hidden = true;
    img.removeAttribute("src");
    empty.hidden = false;
    meta.hidden = true;
    return;
  }
  img.src = image.dataUrl || "";
  img.hidden = false;
  empty.hidden = true;
  meta.hidden = false;
  $("source-name").textContent =
    `${image.name} — ${image.width}×${image.height} px (extracted from a downscaled copy)`;
}

function swatchCard(colour) {
  const card = document.createElement("div");
  card.className =
    "swatch-card" +
    (state.harmonyBase?.hex === colour.hex ? " selected" : "");
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  card.dataset.hex = colour.hex;
  card.title = `${colour.hex} — click to copy HEX, sets the harmony base`;

  const textOn = bestTextColor(colour);
  const colorBlock = document.createElement("div");
  colorBlock.className = "swatch-color";
  colorBlock.style.backgroundColor = colour.hex;
  const hexLabel = document.createElement("span");
  hexLabel.className = "swatch-hex";
  hexLabel.textContent = colour.hex;
  hexLabel.style.color = textOn;
  colorBlock.appendChild(hexLabel);

  const info = document.createElement("div");
  info.className = "swatch-info";
  const rgbLine = document.createElement("span");
  rgbLine.className = "swatch-rgb";
  rgbLine.textContent = formatRgb(colour);
  const hslLine = document.createElement("span");
  hslLine.className = "swatch-rgb";
  hslLine.textContent = formatHsl(colour);
  const shareLine = document.createElement("span");
  shareLine.className = "swatch-share";
  shareLine.textContent =
    colour.share !== undefined
      ? `${colour.share}% of sampled pixels`
      : "From a saved palette";
  info.append(rgbLine, hslLine, shareLine);

  const actions = document.createElement("div");
  actions.className = "swatch-actions";
  const copyHex = document.createElement("button");
  copyHex.type = "button";
  copyHex.className = "btn btn-sm";
  copyHex.textContent = "HEX";
  copyHex.addEventListener("click", (e) => {
    e.stopPropagation();
    copyText(colour.hex, `Copied ${colour.hex}`);
  });
  const copyRgb = document.createElement("button");
  copyRgb.type = "button";
  copyRgb.className = "btn btn-sm";
  copyRgb.textContent = "RGB";
  copyRgb.addEventListener("click", (e) => {
    e.stopPropagation();
    copyText(formatRgb(colour), `Copied ${formatRgb(colour)}`);
  });
  const copyHsl = document.createElement("button");
  copyHsl.type = "button";
  copyHsl.className = "btn btn-sm";
  copyHsl.textContent = "HSL";
  copyHsl.addEventListener("click", (e) => {
    e.stopPropagation();
    copyText(formatHsl(colour), `Copied ${formatHsl(colour)}`);
  });
  const lockBtn = document.createElement("button");
  lockBtn.type = "button";
  lockBtn.className =
    "btn btn-sm lock-btn" + (state.locked.has(colour.hex) ? " locked" : "");
  lockBtn.textContent = state.locked.has(colour.hex) ? "Locked" : "Lock";
  lockBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.locked.has(colour.hex)) state.locked.delete(colour.hex);
    else state.locked.add(colour.hex);
    renderPalette();
  });
  actions.append(copyHex, copyRgb, copyHsl, lockBtn);

  card.append(colorBlock, info, actions);
  const pick = () => {
    copyText(colour.hex, `Copied ${colour.hex}`);
    setHarmonyBase(colour.hex);
  };
  card.addEventListener("click", pick);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick();
    }
  });
  return card;
}

function renderPalette() {
  const grid = $("palette-grid");
  const empty = $("palette-empty");
  grid.innerHTML = "";
  if (state.palette.length === 0) {
    empty.hidden = false;
  } else {
    empty.hidden = true;
    for (const colour of state.palette) grid.appendChild(swatchCard(colour));
  }
  const hasPalette = state.palette.length > 0;
  for (const id of [
    "btn-download-card",
    "btn-copy-css",
    "btn-copy-tailwind",
    "btn-download-json",
    "btn-copy-hexlist",
  ]) {
    $(id).disabled = !hasPalette;
  }
}

function renderHarmonies() {
  const rowsEl = $("harmony-rows");
  const baseEl = $("harmony-base");
  rowsEl.innerHTML = "";
  if (!state.harmonyBase) {
    baseEl.hidden = true;
    return;
  }
  baseEl.hidden = false;
  $("harmony-base-hex").textContent = state.harmonyBase.hex;
  const rows = harmoniesFor(state.harmonyBase);
  const labels = {
    complementary: ["Complementary", "opposite side of the wheel — high contrast"],
    analogous: ["Analogous", "neighbours on the wheel — calm and cohesive"],
    triadic: ["Triadic", "three evenly spaced hues — balanced and vivid"],
    splitComplementary: ["Split complementary", "two neighbours of the opposite hue — contrast without the clash"],
  };
  for (const [key, colours] of Object.entries(rows)) {
    const row = document.createElement("div");
    row.className = "harmony-row";
    const title = document.createElement("h4");
    title.textContent = labels[key][0] + " ";
    const note = document.createElement("span");
    note.textContent = `— ${labels[key][1]}`;
    title.appendChild(note);
    const swatches = document.createElement("div");
    swatches.className = "harmony-swatches";
    for (const colour of colours) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "harmony-swatch";
      sw.style.backgroundColor = colour.hex;
      sw.style.color = bestTextColor(colour);
      sw.textContent = colour.hex;
      sw.title = `${colour.hex} — click to copy`;
      sw.dataset.hex = colour.hex;
      sw.addEventListener("click", () =>
        copyText(colour.hex, `Copied ${colour.hex}`),
      );
      swatches.appendChild(sw);
    }
    row.append(title, swatches);
    rowsEl.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Recents (localStorage, max 10)
// ---------------------------------------------------------------------------

function loadRecents() {
  const stored = loadJson(RECENTS_KEY, []);
  state.recents = Array.isArray(stored) ? stored : [];
}

function saveRecent(sourceName) {
  if (state.palette.length === 0) return;
  const entry = {
    name: sourceName || "Palette",
    source: sourceName || "image",
    hexes: state.palette.map((c) => c.hex),
    createdAt: new Date().toISOString(),
  };
  // Same palette twice in a row is one recent, not two.
  if (
    state.recents[0] &&
    state.recents[0].hexes.join(",") === entry.hexes.join(",")
  ) {
    return;
  }
  state.recents.unshift(entry);
  state.recents = state.recents.slice(0, MAX_RECENT_PALETTES);
  saveJson(RECENTS_KEY, state.recents);
  renderRecents();
}

function renderRecents() {
  const list = $("recents-list");
  const empty = $("recents-empty");
  const clearBtn = $("btn-clear-recents");
  list.innerHTML = "";
  if (state.recents.length === 0) {
    empty.hidden = false;
    clearBtn.hidden = true;
    return;
  }
  empty.hidden = true;
  clearBtn.hidden = false;
  for (const recent of state.recents) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "recent-item";
    const strip = document.createElement("span");
    strip.className = "recent-strip";
    for (const hex of recent.hexes.slice(0, 6)) {
      const dot = document.createElement("span");
      dot.style.backgroundColor = hex;
      dot.title = hex;
      strip.appendChild(dot);
    }
    const meta = document.createElement("span");
    meta.className = "recent-meta";
    const date = new Date(recent.createdAt);
    meta.textContent = `${recent.name} — ${recent.hexes.length} colours, ${date.toLocaleDateString()}`;
    item.append(strip, meta);
    item.addEventListener("click", () => {
      state.palette = recent.hexes
        .map((hex) => colorFromHex(hex))
        .filter(Boolean);
      state.harmonyBase = state.palette[0] || null;
      renderPalette();
      renderHarmonies();
      showToast("Loaded a saved palette.");
    });
    list.appendChild(item);
  }
}

export function clearRecents() {
  state.recents = [];
  saveJson(RECENTS_KEY, []);
  renderRecents();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function copyCss() {
  if (state.palette.length === 0) return Promise.resolve(false);
  return copyText(
    buildCssVariables(state.palette),
    "Copied CSS variables to the clipboard.",
  );
}

export function copyTailwind() {
  if (state.palette.length === 0) return Promise.resolve(false);
  return copyText(
    buildTailwindConfig(state.palette),
    "Copied Tailwind config snippet to the clipboard.",
  );
}

export function copyHexList() {
  if (state.palette.length === 0) return Promise.resolve(false);
  return copyText(
    buildHexList(state.palette),
    "Copied all HEX codes to the clipboard.",
  );
}

export function downloadJson() {
  if (state.palette.length === 0) return false;
  const image = currentImage();
  const text = buildPaletteJson(state.palette, {
    name: image ? image.name : "PalettePick palette",
    source: image ? image.name : "image",
  });
  const blob = new Blob([text], { type: "application/json" });
  return downloadBlob(blob, paletteFilename(image?.name || "palette", "json"));
}

/** Draw the shareable palette card onto a canvas and return it. */
export function drawPaletteCard(canvas, palette, width = 1200) {
  const pad = 64;
  const gap = 16;
  const swatchH = 300;
  const titleH = 140; // title line + subtitle line + breathing room before the swatches
  const footerH = 64;
  const height = pad + titleH + swatchH + 52 + footerH + pad;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available in this browser.");

  ctx.fillStyle = "#0B0B0F";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#F5F5F7";
  ctx.font = "800 64px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("PalettePick", pad, pad + 64);

  ctx.fillStyle = "#9A9AA5";
  ctx.font = "500 26px Inter, system-ui, sans-serif";
  ctx.fillText("Extracted from your image — in your browser, nothing uploaded.", pad, pad + 108);

  const n = palette.length;
  const swatchW = (width - pad * 2 - gap * (n - 1)) / n;
  palette.forEach((colour, i) => {
    const x = pad + i * (swatchW + gap);
    const y = pad + titleH;
    ctx.fillStyle = colour.hex;
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(x, y, swatchW, swatchH, 18);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, swatchW, swatchH);
    }
    ctx.fillStyle = bestTextColor(colour);
    ctx.font = "700 30px Inter, system-ui, sans-serif";
    ctx.fillText(colour.hex, x + 18, y + swatchH - 20);
  });

  ctx.fillStyle = "#9A9AA5";
  ctx.font = "500 24px Inter, system-ui, sans-serif";
  ctx.fillText("palettepick-app.vercel.app", pad, height - pad - 8);
  ctx.textAlign = "right";
  ctx.fillText("Built by krrish", width - pad, height - pad - 8);
  return canvas;
}

export function downloadPaletteCard() {
  if (state.palette.length === 0) return false;
  const width = Number($("card-size-select").value) || 1200;
  const canvas = document.createElement("canvas");
  drawPaletteCard(canvas, state.palette, width);
  const image = currentImage();
  const filename = paletteFilename(
    `${image?.name || "palette"}-card`,
    "png",
  );
  if (typeof canvas.toBlob === "function") {
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, filename);
      else showToast("Could not render the palette card.");
    }, "image/png");
    return true;
  }
  try {
    const dataUrl = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch (err) {
    showToast("Could not render the palette card in this browser.");
    return false;
  }
}

// ---------------------------------------------------------------------------
// State snapshot (used by the test harness)
// ---------------------------------------------------------------------------

export function getState() {
  const harmonies = state.harmonyBase
    ? harmoniesFor(state.harmonyBase)
    : null;
  return {
    siteUrl: SITE_URL,
    imageCount: state.images.length,
    currentImageName: currentImage()?.name || null,
    paletteHexes: state.palette.map((c) => c.hex),
    paletteCount: state.palette.length,
    harmonyBaseHex: state.harmonyBase?.hex || null,
    harmonyRows: harmonies
      ? Object.fromEntries(
          Object.entries(harmonies).map(([k, v]) => [k, v.map((c) => c.hex)]),
        )
      : null,
    lockedHexes: [...state.locked],
    sortMode: state.sortMode,
    recentsCount: state.recents.length,
    toastText: $("toast").textContent,
    exportDisabled: $("btn-download-card").disabled,
    sourceImgHidden: $("source-img").hidden,
  };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  loadRecents();
  renderRecents();

  const dropZone = $("drop-zone");
  const fileInput = $("file-input");

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", () =>
    dropZone.classList.remove("drag-over"),
  );
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const files = [...(e.dataTransfer?.files || [])];
    files.slice(0, MAX_IMAGES).forEach((f) => loadImageFile(f));
  });
  fileInput.addEventListener("change", () => {
    const files = [...(fileInput.files || [])];
    files.slice(0, MAX_IMAGES).forEach((f) => loadImageFile(f));
    fileInput.value = "";
  });

  document.addEventListener("paste", (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (file) loadImageFile(file);
  });

  $("btn-sample").addEventListener("click", () =>
    loadSample($("sample-select").value),
  );

  $("color-count").addEventListener("input", (e) => {
    $("color-count-value").textContent = e.target.value;
  });
  $("color-count").addEventListener("change", () => extractCurrent());
  $("quality-select").addEventListener("change", () => extractCurrent());
  $("exclude-extremes").addEventListener("change", () => extractCurrent());
  $("sat-floor").addEventListener("input", (e) => {
    $("sat-floor-value").textContent = `${e.target.value}%`;
  });
  $("sat-floor").addEventListener("change", () => extractCurrent());
  $("sort-select").addEventListener("change", (e) => setSort(e.target.value));
  $("btn-reextract").addEventListener("click", () => {
    extractCurrent();
    showToast("Palette re-extracted.");
  });

  $("source-img").addEventListener("click", (e) => {
    const image = currentImage();
    if (!image) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = rect.width > 0 ? image.width / rect.width : 0;
    const scaleY = rect.height > 0 ? image.height / rect.height : 0;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    pickColorAt(x, y);
  });

  $("btn-hex-harmony").addEventListener("click", () => {
    const raw = $("hex-input").value.trim();
    const colour = colorFromHex(raw);
    if (!colour) {
      showToast("That doesn't look like a HEX colour — try #E5484D.");
      return;
    }
    setHarmonyBase(colour.hex);
    showToast(`Harmonies for ${colour.hex} are below.`);
  });
  $("hex-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-hex-harmony").click();
  });

  $("btn-download-card").addEventListener("click", downloadPaletteCard);
  $("btn-copy-css").addEventListener("click", copyCss);
  $("btn-copy-tailwind").addEventListener("click", copyTailwind);
  $("btn-download-json").addEventListener("click", downloadJson);
  $("btn-copy-hexlist").addEventListener("click", copyHexList);
  $("btn-clear-recents").addEventListener("click", clearRecents);

  // First paint should already do something useful: load the sunset
  // sample so the palette, harmonies and exports work with zero upload.
  loadSample("sunset");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
