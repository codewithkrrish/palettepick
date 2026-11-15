# PalettePick — Free Image to Colour Palette Extractor

I built PalettePick because I kept screenshotting photos I liked, then guessing at the colours in them by eye — and guessing badly. This one does the honest version: drop an image in, it pulls out the dominant colours with a plain median-cut quantiser, and every swatch is one click away from your clipboard as HEX, RGB or HSL.

## What it does

- **Image intake three ways** — drag and drop, file picker, or paste straight from the clipboard (Ctrl+V). PNG, JPG and WebP, up to 10 MB each, and up to 8 images in a batch with a thumbnail strip to switch between them.
- **Dominant colour extraction** — pick 3–10 colours, choose extraction quality (precise / balanced / fast), ignore near-white and near-black, and set a minimum saturation to push dull greys out.
- **Click-to-copy everywhere** — click a swatch to copy its HEX; each swatch also has its own HEX, RGB and HSL copy buttons, plus a toast so you know it worked.
- **Harmony rows** — for the top colour (or any colour you click, or any HEX you type in), complementary, analogous, triadic and split-complementary rows, each swatch click-copyable.
- **Lock and re-extract** — lock a colour you love and re-extract the rest around it.
- **Sort the palette** — by frequency, luminance, hue or saturation.
- **Exports** — a shareable palette card as PNG (three sizes), CSS variables, a Tailwind config snippet, palette JSON download, and all HEX codes as one comma list.
- **Click the image to pick a colour** — click anywhere on the source image and that exact pixel becomes the harmony base.
- **Samples built in** — six gradient samples (sunset, ocean, forest, berry, desert, slate) so the tool works with zero upload. One loads automatically on first visit.
- **Recent palettes** — the last 10 palettes are saved on your device (localStorage) and reload with a click. Clear them any time.

## How to run it

No build step, no install, no dependencies. Serve the folder (`python3 -m http.server`) and open `index.html`, or drop the files on any static host. Everything runs in your browser; nothing is uploaded, ever.

## How it works

`js/engine.js` is pure logic with no DOM: RGB/HEX/HSL conversions, relative luminance and contrast, a hand-written median-cut quantiser, hue-based harmony generators, palette sorting, and the CSS/Tailwind/JSON export builders. `js/main.js` is DOM wiring only. Tests live outside the repo in `~/workspace/tool-sites/notes/palettepick-harness/` — a logic suite against the real engine and a jsdom suite that runs the real `index.html` module graph.

The extraction pipeline: your image is drawn to a canvas at most 240 px wide, its pixels are sampled (every 1st, 2nd or 4th pixel depending on the quality setting), near-white/near-black and low-saturation pixels are filtered out if you asked for that, and median-cut splits the remaining pixels into groups by their widest colour channel until it has the number of colours you asked for. Each swatch is the average colour of its group, weighted by pixel count.

## Honest limits

- Extraction is approximate. Colours are quantised from a downscaled copy, so a swatch is the most common colour of a colour family, not necessarily one exact pixel from the original. Near-pure colours are snapped to the pure value (flat red reads #FF0000, not #FE0001 — browsers dither pure colours by ±1 through their canvas pipeline); in-between shades are left alone.
- Very small images give few colours. A 32×32 icon may only hold two or three distinct colours — asking for ten will not invent more.
- Gradients give many similar shades. A smooth sky gradient quantises into a row of near-identical blues.
- Near-white and near-black are ignored by default, so a white border or black background doesn't swallow the palette. Uncheck the box if you genuinely want them.
- Harmonies are computed, not designed. The hue maths is exact (complementary is +180°, analogous ±30°), but a complementary pair can still clash in a real design — taste is yours.

## License

MIT — see `LICENSE`.
