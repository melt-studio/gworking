// Build the portfolio from Airtable -> public/index.html (+ public/assets)
// Run: AIRTABLE_TOKEN=xxx node build.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffprobe from "@ffprobe-installer/ffprobe";

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
  let records = [], offset;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}`);
    u.searchParams.set("pageSize","100");
    if (offset) u.searchParams.set("offset", offset);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${TOKEN}` } });
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

const records = await fetchAll();
let about = "";
const projects = [];

for (const rec of records) {
  const f = rec.fields;
  if (f[F.name] === "About") { about = f[F.copy] || ""; continue; }
  if (!f[F.name]) continue;
  const slug = slugify(f[F.name]);
  const folder = path.join(ASSETS, slug);

  async function media(att, fname) {
    const dest = path.join(folder, fname);
    await download(att.url, dest);
    let w = att.width, h = att.height;
    if ((att.type||"").startsWith("video")) { const d = videoDims(dest); if (d) { w = d.width; h = d.height; } }
    return { file: path.relative(OUT, dest).split(path.sep).join("/"), type: att.type, w, h };
  }

  const th = f[F.thumb] || [], imgs = f[F.imgs] || [];
  const thumb = th[0] ? await media(th[0], "thumbnail" + extFor(th[0])) : null;
  const slides = [];
  for (let i = 0; i < imgs.length; i++) slides.push(await media(imgs[i], String(i+1).padStart(2,"0") + extFor(imgs[i])));

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
fs.writeFileSync(path.join(OUT, "index.html"), html);
console.log(`\nBuilt ${projects.length} projects -> ${OUT}/index.html`);
