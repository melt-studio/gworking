# gworking — Greg Zadrozny portfolio

A static portfolio site whose content (projects, images, copy, About) is built from
Airtable at deploy time. Edit Airtable → the site rebuilds → it redeploys.

## How it works

- `template.html` — the design (canvas, slideshow, styles). Content placeholders only.
- `build.mjs` — at build time, pulls the `projects` table from Airtable, downloads
  every thumbnail/image into `public/assets/`, fixes video display aspect ratios,
  and writes `public/index.html` with the data inlined.
- Vercel runs `npm run build` and serves the `public/` folder.

Airtable controls **content**. The **design** lives in `template.html` (code).

## What's in Airtable (base `appJ5XFh9jxMVKJYA`, table `projects`)

| Field | Use |
|-------|-----|
| name | Project title (a row named `About` holds the About-page copy) |
| client | Client label |
| copy | Description shown in the project slideshow |
| projectThumbnail | The tile on the home canvas (image, gif, or video) |
| projectImages | The slideshow images/videos, in order |

To add a project: add a row, fill the fields, attach images. To reorder, change the
row order in Airtable. To edit the About page, edit the `About` row's copy.

## One-time setup

### 1. Airtable token
Create a Personal Access Token at https://airtable.com/create/tokens
- Scope: `data.records:read`
- Access: the base that contains this `projects` table
Copy the token (starts with `pat...`).

### 2. Push this folder to GitHub
```
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/melt-studio/gworking.git
git push -u origin main
```

### 3. Vercel
1. Sign in to https://vercel.com with GitHub.
2. **Add New → Project** → import `melt-studio/gworking`.
3. Vercel reads `vercel.json` (build `npm run build`, output `public`).
4. **Environment Variables** → add `AIRTABLE_TOKEN` = your `pat...` token.
   (Optional: `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE` if they ever change.)
5. Deploy. You'll get a `*.vercel.app` URL. Add a custom domain later if you want.

### 4. Auto-rebuild when Airtable changes (optional but recommended)
1. In Vercel: **Project → Settings → Git → Deploy Hooks** → create a hook
   (e.g. name "airtable", branch `main`). Copy the hook URL.
2. In Airtable: **Automations → Create automation** → trigger "When record updated"
   (table `projects`) → action "Run script" or "Send webhook" → POST to the hook URL.
   Now editing Airtable triggers a redeploy.

## Run locally
```
npm install
AIRTABLE_TOKEN=pat... npm run build
npx serve public        # or open public/index.html via a local server
```
> Open it through a local server (not file://) so video/image paths resolve cleanly.

## Notes
- Images are downloaded fresh on every build (not committed) — `public/` is gitignored.
- Airtable attachment URLs expire after ~2 hours, which is why we copy them at build
  time rather than linking to them directly.
