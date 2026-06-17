// Build the portfolio from Airtable -> public/index.html (+ public/assets)
// Run: AIRTABLE_TOKEN=xxx node build.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffprobe from "@ffprobe-installer/ffprobe";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import sharp from "sharp";

// retina-safe ceilings (longest edge, px). Files within these are left untouched.
const MAX_THUMB = 1200;
const MAX_SLIDE = 2560;

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE  = process.env.AIRTABLE_BASE_ID || "appJ5XFh9jxMVKJYA";
const TABLE = process.env.AIRTABLE_TABLE   || "projects";
const OUT    = "public";
const ASSETS = path.join(OUT, "assets", "projects");

if (!TOKEN) { console.error("ERROR: set AIRTABLE_TOKEN (Airtable personal access token)."); process.exit(1); }

const F = { name:"name", url:"projectUrl", client:"client", copy:"copy", thumb:"projectThumbnail", imgs:"projectImages" };

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

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status} for ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
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

// extract a video's first frame as a poster image (scaled to display dims) so video
// thumbnails paint instantly like static images
function posterFor(file, w, h) {
  const out = file.replace(/\.[^.]+$/, ".poster.jpg");
  try {
    const vf = (w && h) ? `scale=${w}:${h}` : "scale=iw:ih";
    execFileSync(ffmpeg.path, ["-y", "-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", vf, "-q:v", "3", out]);
    return path.relative(OUT, out).split(path.sep).join("/");
  } catch (e) { console.warn("  poster skip", path.basename(file), e.message); return null; }
}

// Quality-first image optimization. Only DOWNSCALES files past the ceiling
// (single high-quality Lanczos resample + near-lossless encode). Files already
// within budget are left exactly as uploaded — no re-compression, no quality loss.
async function optimizeImage(file, maxEdge) {
  const ext = path.extname(file).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return null;  // skip gif/mp4/etc
  try {
    const meta = await sharp(file).metadata();
    const longest = Math.max(meta.width || 0, meta.height || 0);
    const needResize = longest > maxEdge;
    // JPEGs within budget: leave untouched to avoid generation loss.
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
const projects = [];

for (const rec of records) {
  const f = rec.fields;
  if (f[F.name] === "About") { about = f[F.copy] || ""; continue; }
  if (!f[F.name]) continue;
  // unique per record so duplicate project titles never share/overwrite an asset folder
  const slug = slugify(f[F.name]) + "-" + rec.id;
  const folder = path.join(ASSETS, slug);

  async function media(att, fname, maxEdge) {
    const dest = path.join(folder, fname);
    await download(att.url, dest);
    let w = att.width, h = att.height, poster;
    const type = att.type || "";
    if (type.startsWith("video")) {
      const d = videoDims(dest); if (d) { w = d.width; h = d.height; }
      poster = posterFor(dest, w, h);
    }
    else if (maxEdge) { const d = await optimizeImage(dest, maxEdge); if (d) { w = d.width; h = d.height; } }
    const out = { file: path.relative(OUT, dest).split(path.sep).join("/"), type, w, h };
    if (poster) out.poster = poster;
    return out;
  }

  const th = f[F.thumb] || [], imgs = f[F.imgs] || [];
  const thumb = th[0] ? await media(th[0], "thumbnail" + extFor(th[0]), MAX_THUMB) : null;
  const slides = [];
  for (let i = 0; i < imgs.length; i++) slides.push(await media(imgs[i], String(i+1).padStart(2,"0") + extFor(imgs[i]), MAX_SLIDE));

  projects.push({ name: f[F.name], slug, client: f[F.client] || "", copy: f[F.copy] || "", thumb, slides, gallery: [] });
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
