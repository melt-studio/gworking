// Build the portfolio from Airtable -> public/index.html (+ public/assets)
// Run: AIRTABLE_TOKEN=xxx node build.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffprobe from "@ffprobe-installer/ffprobe";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import sharp from "sharp";
import crypto from "node:crypto";

// retina-safe ceilings (longest edge, px). Files within these are left untouched.
const MAX_THUMB = 1200;
const MAX_SLIDE = 2560;

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE  = process.env.AIRTABLE_BASE_ID || "appJ5XFh9jxMVKJYA";
const TABLE = process.env.AIRTABLE_TABLE   || "projects";
const OUT    = "public";
const ASSETS = path.join(OUT, "assets", "projects");
function ver(rel) {                       // content-hash query so a changed asset gets a fresh URL (no stale cache)
  try {
    const h = crypto.createHash("md5").update(fs.readFileSync(path.join(OUT, rel))).digest("hex").slice(0, 8);
    return rel + "?v=" + h;
  } catch { return rel; }
}

if (!TOKEN) { console.error("ERROR: set AIRTABLE_TOKEN (Airtable personal access token)."); process.exit(1); }

const F = { name:"name", overview:"scope", client:"client", copy:"copy", thumb:"projectThumbnail", imgs:"projectImages", ref:"ref" };

const slugify = s => s.toLowerCase().replace(/&/g,"and").replace(/['’]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
const extFor  = a => { const e = path.extname(a.filename||"").toLowerCase();
  return e || ({ "image/jpeg":".jpg","image/png":".png","image/gif":".gif","video/mp4":".mp4" }[a.type] || ".bin"); };
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

async function fetchAll() {
  // read records in the grid view's row order (top of the table = seen first on the site)
  let records = [], offset, view = process.env.AIRTABLE_VIEW || "Grid view";
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}`);
    u.searchParams.set("pageSize","100");
    if (view) u.searchParams.set("view", view);
    if (offset) u.searchParams.set("offset", offset);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!r.ok && view) {                 // view name not found -> fall back to default order
      console.warn(`  view "${view}" not usable (${r.status}); using default record order`);
      view = null; continue;
    }
    if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
    const j = await r.json(); records.push(...j.records); offset = j.offset;
  } while (offset);
  return records;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Airtable attachment URLs are temporary and occasionally 4xx/5xx; retry with backoff
async function download(url, dest, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`download ${r.status} for ${url}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      return;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(500 * (i + 1));   // 0.5s, 1s, 1.5s
    }
  }
  throw lastErr;
}

// videos can have non-square pixels; use the DISPLAY aspect, not the coded size
function videoDims(file) {
  try {
    const out = execFileSync(ffprobe.path, ["-v","error","-select_streams","v:0",
      "-show_entries","stream=width,height,sample_aspect_ratio","-of","json", file]).toString();
    const st = JSON.parse(out).streams[0];
    let { width:w, height:h } = st; let sar = st.sample_aspect_ratio;
    if (!sar || sar === "0:1" || sar === "N/A") sar = "1:1";
    const [sn, sd] = sar.split(":").map(Number);
    return { width: Math.round(w * sn / sd), height: h };
  } catch { return null; }
}

// Bake a still for each video (scaled to display dims) so video thumbnails paint
// instantly like static images. Prefers a near-FINAL frame (animations usually resolve
// on their end state, so it reads as more representative), falling back to the first
// frame. Seeks from the end rather than buffering the file, so long clips stay cheap.
function posterFor(file, w, h) {
  const out = file.replace(/\.[^.]+$/, ".poster.jpg");
  const vf = (w && h) ? `scale=${w}:${h}` : "scale=iw:ih";
  const rel = () => path.relative(OUT, out).split(path.sep).join("/");
  const run = (pre) => execFileSync(ffmpeg.path, ["-y", "-loglevel", "error", ...pre, "-i", file, "-frames:v", "1", "-vf", vf, "-q:v", "3", out]);
  const ok = () => { try { return fs.statSync(out).size > 1024; } catch { return false; } };
  try { run(["-sseof", "-0.3"]); if (ok()) return rel(); } catch {}
  try { run([]); if (ok()) return rel(); } catch (e) { console.warn("  poster skip", path.basename(file), e.message); }
  return null;
}

// Canvas thumbnail videos are drawn as small tiles and always muted, so the source bitrate and
// audio track are pure waste. Re-encode to a modest size with no audio. Slide videos (project
// pages, shown large and sometimes with sound) are never touched by this.
function compressThumbVideo(file, w, h) {
  if (!/\.mp4$/i.test(file)) return null;                 // only re-wrap formats we know are safe
  const tmp = file.replace(/\.mp4$/i, ".min.mp4");
  const TARGET = 720;
  try {
    const longest = Math.max(w || 0, h || 0);
    // out_range=pc + explicit BT.709 tags keep flat colours as close to the source as 8-bit YUV
    // allows. Without them H.264 defaults to limited range (16-235) and a flat background drifts
    // ~4 levels off the page colour; this halves that. (4:4:4 would be closer still but Safari
    // and iOS can't hardware-decode it.)
    const size = longest > TARGET
      ? `w='if(gt(iw,ih),${TARGET},-2)':h='if(gt(iw,ih),-2,${TARGET})'`
      : "w=trunc(iw/2)*2:h=trunc(ih/2)*2";                 // h264 needs even dimensions
    const vf = `scale=${size}:out_range=pc,format=yuv420p`;
    execFileSync(ffmpeg.path, ["-y", "-loglevel", "error", "-i", file,
      "-vf", vf, "-an",                                    // -an: strip audio, tiles are muted
      "-c:v", "libx264", "-crf", "30", "-preset", "medium", "-pix_fmt", "yuv420p",
      "-color_range", "pc", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
      "-movflags", "+faststart", tmp]);
    const before = fs.statSync(file).size, after = fs.statSync(tmp).size;
    if (after < before) { fs.renameSync(tmp, file); console.log(`    video ${(before/1048576).toFixed(2)}MB -> ${(after/1048576).toFixed(2)}MB`); }
    else fs.unlinkSync(tmp);                               // never bloat
    return videoDims(file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    console.warn("  video compress skip", path.basename(file), e.message);
    return null;
  }
}

// Animated GIFs repaint constantly and tank scrolling on phones, so bake a static
// frame we can serve there instead. Uses the LAST frame (animations usually resolve
// on their final composed state) via a reverse-then-grab-first trick.
function gifPosterFor(file) {
  const out = file.replace(/\.[^.]+$/, ".poster.jpg");
  try {
    execFileSync(ffmpeg.path, ["-y", "-loglevel", "error", "-i", file, "-vf", "reverse", "-frames:v", "1", "-q:v", "3", out]);
    return path.relative(OUT, out).split(path.sep).join("/");
  } catch (e) { console.warn("  gif poster skip", path.basename(file), e.message); return null; }
}

// Quality-first image optimization. Only DOWNSCALES files past the ceiling
// (single high-quality Lanczos resample + near-lossless encode). Files already
// within budget are left exactly as uploaded — no re-compression, no quality loss.
async function optimizeImage(file, maxEdge, isThumb) {
  const ext = path.extname(file).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return null;  // skip gif/mp4/etc
  try {
    const meta = await sharp(file).metadata();
    const longest = Math.max(meta.width || 0, meta.height || 0);
    const needResize = longest > maxEdge;

    // THUMBNAILS: drawn as small tiles on the canvas and they gate the first paint, so compress
    // hard. Opaque images become JPEG (a lossless PNG tile can be 15x bigger for no visible gain);
    // images with real transparency stay PNG but get quantised. Slide images are untouched below.
    if (isThumb) {
      const opaque = !meta.hasAlpha;
      let p = sharp(file, { failOn: "none" })
        .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" });
      let outFile = file;
      if (ext === ".png" && !opaque) {
        p = p.png({ compressionLevel: 9, palette: true, quality: 80 });
      } else {
        p = p.jpeg({ quality: 80, mozjpeg: true });
        outFile = file.replace(/\.[^.]+$/, ".jpg");
      }
      const buf = await p.toBuffer();
      const fin = await sharp(buf).metadata();
      fs.writeFileSync(outFile, buf);
      if (outFile !== file) { try { fs.unlinkSync(file); } catch {} }
      return { width: fin.width, height: fin.height, file: outFile };
    }

    // SLIDES: quality-first. Only downscale past the ceiling; never re-compress a JPEG in budget.
    if ((ext === ".jpg" || ext === ".jpeg") && !needResize) return { width: meta.width, height: meta.height };
    let p = sharp(file, { failOn: "none" });
    if (needResize) p = p.resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" });
    if (ext === ".png")       p = p.png({ compressionLevel: 9 });                                  // lossless
    else if (ext === ".webp") p = p.webp({ quality: 92 });
    else                      p = p.jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: "4:4:4" }); // full chroma

    const buf = await p.toBuffer();
    const fin = await sharp(buf).metadata();
    if (needResize || buf.length < fs.statSync(file).size) fs.writeFileSync(file, buf);  // never bloat
    return { width: fin.width, height: fin.height };
  } catch (e) { console.warn("  optimize skip", path.basename(file), e.message); return null; }
}

const records = await fetchAll();
let about = "";
let failures = 0;
const projects = [];

for (const rec of records) {
  const f = rec.fields;
  // The About row does double duty: its copy always feeds the About page, and if you give it a
  // projectThumbnail it ALSO becomes a card on the canvas / a row in the index that opens About
  // (the "secret" link). Leave that attachment empty and it stays hidden exactly as before.
  const isAboutRow = f[F.name] === "About";
  // only take copy that actually has content — a stray/empty "About" row must never blank the page
  if (isAboutRow && (f[F.copy] || "").trim()) about = f[F.copy];
  if (isAboutRow && !(f[F.thumb] || [])[0]) continue;
  if (!f[F.name]) continue;
  // unique per record so duplicate project titles never share/overwrite an asset folder
  const slug = slugify(f[F.name]) + "-" + rec.id;
  const folder = path.join(ASSETS, slug);

  async function media(att, fname, maxEdge) {
    let dest = path.join(folder, fname);
    await download(att.url, dest);
    let w = att.width, h = att.height, poster;
    const type = att.type || "";
    if (type.startsWith("video")) {
      const d = videoDims(dest); if (d) { w = d.width; h = d.height; }
      poster = posterFor(dest, w, h);                       // poster taken from the original, before re-encode
      if (maxEdge === MAX_THUMB) {                          // canvas tile: shrink it
        const c = compressThumbVideo(dest, w, h);
        if (c) { w = c.width; h = c.height; }
      }
    }
    else if (/\.gif$/i.test(dest) || type === "image/gif") { poster = gifPosterFor(dest); }   // static frame for phones
    else if (maxEdge) {
      const d = await optimizeImage(dest, maxEdge, maxEdge === MAX_THUMB);
      if (d) { w = d.width; h = d.height; if (d.file) dest = d.file; }   // thumbnails may become .jpg
    }
    const rel = path.relative(OUT, dest).split(path.sep).join("/");
    const out = { file: ver(rel), type, w, h };
    if (poster) out.poster = ver(poster);
    if (/_websitediv/i.test(att.filename || "")) out.divider = true;   // spacer image: shown on the desktop filmstrip, hidden on phone
    return out;
  }

  // never let a single flaky attachment kill the whole deploy — skip it and keep going
  async function safeMedia(att, fname, maxEdge) {
    try { return await media(att, fname, maxEdge); }
    catch (e) { console.warn(`  SKIP ${slug}/${fname}: ${e.message}`); failures++; return null; }
  }

  const th = f[F.thumb] || [], imgs = f[F.imgs] || [];
  const thumb = th[0] ? await safeMedia(th[0], "thumbnail" + extFor(th[0]), MAX_THUMB) : null;
  const slides = [];
  for (let i = 0; i < imgs.length; i++) {
    const s = await safeMedia(imgs[i], String(i+1).padStart(2,"0") + extFor(imgs[i]), MAX_SLIDE);
    if (s) slides.push(s);
  }

  // a project with no usable thumbnail can't be tiled on the canvas — drop it
  if (!thumb) { console.warn(`  DROP ${slug}: no thumbnail`); continue; }

  projects.push({
    name: f[F.name], slug,
    client: f[F.client] || "",
    copy: isAboutRow ? "" : (f[F.copy] || ""),          // About text already ships with the About page
    overview: f[F.overview] || "",
    ref: isAboutRow ? "about" : (f[F.ref] || ""),       // marks it as the secret About link
    thumb, slides, gallery: [],
  });
  console.log(`  ${slug}: thumb ${thumb?1:0}, slides ${slides.length}`);
}

const payload = JSON.stringify(projects).replace(/<\//g, "<\\/");
const blocks = about.split(/\n\n+/).map(b=>b.trim()).filter(Boolean);
const aboutHead = blocks[0] || "Greg Zadrozny";
const aboutParas = blocks.slice(1).map(b=>`<p>${esc(b)}</p>`).join("");

const html = fs.readFileSync("template.html","utf8")
  .replace("__PAYLOAD__", payload)
  .replace("__ABOUTHEAD__", esc(aboutHead))
  .replace("__ABOUT__", aboutParas);

fs.mkdirSync(OUT, { recursive: true });

// copy static favicon assets into the output (served at /assets/favicon/*)
const FAV_SRC = "static/favicon", FAV_DST = path.join(OUT, "assets", "favicon");
if (fs.existsSync(FAV_SRC)) {
  fs.mkdirSync(FAV_DST, { recursive: true });
  const fav = fs.readdirSync(FAV_SRC);
  for (const fn of fav) fs.copyFileSync(path.join(FAV_SRC, fn), path.join(FAV_DST, fn));
  console.log(`  copied ${fav.length} favicon files -> ${FAV_DST}`);
}

fs.writeFileSync(path.join(OUT, "index.html"), html);
console.log(`\nBuilt ${projects.length} projects -> ${OUT}/index.html`);
if (failures) console.warn(`  (${failures} attachment(s) skipped after retries)`);
// guard against a totally empty build (e.g. Airtable outage) overwriting a good site
if (projects.length === 0) { console.error("ERROR: no projects built — refusing to publish empty site."); process.exit(1); }
