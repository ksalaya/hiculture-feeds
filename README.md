# HiCulture feed refresher

The HiCulture web page (kylesalaya.com/hiculture) can't read most RSS feeds or
California court websites itself: browsers block those requests (this is
called CORS). This folder fixes that with a free GitHub setup:

1. Every night a GitHub Action (a small scheduled job that runs on GitHub's
   computers) runs two scripts:
   - `scripts/refresh.mjs` fetches all 157 feeds in `feeds.json` and writes
     **`docs/feed.json`**.
   - `scripts/law-library.mjs` fetches California law updates, jury
     instruction documents, statutes and Rules of Court and writes
     **`docs/law-library.json`**.
2. GitHub Pages publishes the `docs/` folder as a website. The Weebly page
   loads both files from there.

GitHub Pages sends `Access-Control-Allow-Origin: *` with every file, so any
web page, including the Weebly one, is allowed to load them.

You don't need git or a terminal. Everything below happens on github.com.

---

## The app files (docs/app/)

`docs/app/` holds the HiCulture website's own files (its JavaScript, question
banks, MIT course catalog and card images). GitHub Pages serves them at
`https://<user>.github.io/hiculture-feeds/app/`, and the Weebly page layout
loads them from there, so nothing has to be uploaded to Weebly's theme Assets.
`web/build.mjs` fills this folder; upload it together with everything else.

## One-time setup (about 15 minutes)

### 1. Create a GitHub account (skip this if you have one)

1. Go to https://github.com/signup.
2. Enter your email, a password and a username. Your username becomes part of
   the feed address, for example `https://USERNAME.github.io/...`.
3. Pick the **Free** plan.

### 2. Create the repository

A repository ("repo") is a project folder on GitHub.

1. Sign in, click the **+** in the top-right corner and choose **New repository**.
2. **Repository name:** `hiculture-feeds` (exactly that).
3. Choose **Public**. GitHub Pages and unlimited Action minutes are free
   only for public repos. Nothing private is stored here.
4. Leave the other options alone (no README, no .gitignore, no license).
5. Click **Create repository**.

### 3. Upload the files

The upload must include the hidden `.github` folder, because that is where
the nightly job lives. Finder hides any folder whose name starts with a dot.

**Option A: drag and drop (easiest)**

1. In Finder, open this folder (`STEP-3-GITHUB-NIGHTLY-UPDATES` inside `WEBSITE-UPLOAD`).
2. Press **Cmd + Shift + .** (Command, Shift and the period key) to show
   hidden files. `.github` and `docs/.nojekyll` should now appear, slightly
   faded.
3. On the new repo's page, click the **uploading an existing file** link, or
   **Add file → Upload files**.
4. In Finder, press **Cmd + A** to select everything *inside* `STEP-3-GITHUB-NIGHTLY-UPDATES`
   (`.github`, `docs`, `scripts`, `feeds.json`, `README.md`) and drag it onto
   the GitHub upload area. Drag the contents, not the folder itself.
5. Wait for every file to finish uploading. The list should include
   `.github/workflows/refresh.yml`.
6. Click **Commit changes**.
7. Press **Cmd + Shift + .** again in Finder to hide hidden files again, if
   you like.

**Option B: if `.github` didn't upload**

1. In the repo, click **Add file → Create new file**.
2. In the name box, type `.github/workflows/refresh.yml`. Each `/` you type
   turns into a folder.
3. Open `.github/workflows/refresh.yml` from this folder in TextEdit, copy
   all of it and paste it into the big text box.
4. Click **Commit changes…** and then **Commit changes**.

(`docs/.nojekyll` is an empty file that's nice to have but not required. If
it's missing, the JSON files are still published.)

### 4. Let the job save its results

1. In the repo, click **Settings** (the tab with the gear icon).
2. In the left sidebar, click **Actions → General**.
3. Scroll to **Workflow permissions**, select **Read and write permissions**
   and click **Save**.

### 5. Turn on GitHub Pages

1. Still in **Settings**, click **Pages** in the left sidebar.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Under **Branch**, choose **main** and then the folder **/docs**. Click **Save**.
4. After a minute or two, the page shows "Your site is live at
   `https://USERNAME.github.io/hiculture-feeds/`".

### 6. Run the job once by hand

1. Click the **Actions** tab. If GitHub asks, click **I understand my
   workflows, go ahead and enable them**.
2. In the left list, click **Refresh HiCulture feeds**.
3. Click **Run workflow** (on the right) and then the green **Run workflow**
   button.
4. After about 2 to 5 minutes, the run should show a green check. A red X can
   still mean most data refreshed. See [Troubleshooting](#troubleshooting).

### 7. Check the feed

Open these in your browser, using your own username:

- `https://USERNAME.github.io/hiculture-feeds/feed.json`
- `https://USERNAME.github.io/hiculture-feeds/law-library.json`

You should see a lot of text that starts with `{"schemaVersion":1,`. Pages
can take a minute or two after each run to update.

### 8. Connect the Weebly page

1. In Weebly, open **Theme > Edit HTML/CSS** and the **hiculture** Header Type.
2. The pasted layout already reads
   `data-feed-url="https://ksalaya.github.io/hiculture-feeds/feed.json"`.
3. If your repo is under a different username, replace `ksalaya` there with it.
   **Save**, then **Publish**.
4. Reload https://www.kylesalaya.com/hiculture.html. The Today banner should say
   "Verified curriculum · live reading" with last night's date.

The page also loads the Law Library. It finds that file by replacing
`feed.json` with `law-library.json` in the same address, so both files must
stay together in `docs/`. You don't set a second attribute.

---

## What runs, and when

- **Nightly at 10:17 UTC** (3:17 am Pacific in summer, 2:17 am in winter).
  You can also run it any time from **Actions → Refresh HiCulture feeds → Run workflow**.
- **RSS feeds:** refreshed every night. Each feed keeps at most 30 items. Items
  older than 120 days are dropped unless that feed has nothing newer. Items
  linking to wikipedia.org, biography.com or openlibrary.org are dropped (the
  app treats those as low-trust). Duplicates across feeds are removed (same
  URL, or nearly identical title and summary), the same way the iOS app does
  it.
- **If a feed fails** on a given night, its items from the previous night are
  kept, so content doesn't disappear.
- **Law updates and jury instructions:** refreshed every night.
- **Statutes and Rules of Court:** refreshed weekly (on Sundays, or when an
  entry is more than 7 days old). Requests to each site are limited to one
  per second. If a fetch fails, the previous text is kept. To refetch
  everything now, run the workflow by hand and tick **Refetch every statute
  and rule now**.
- Statute and rule texts longer than 12,000 characters are cut off with a
  note pointing to the source link.

### Files in `docs/` (all published)

| File | What it is |
|---|---|
| `feed.json` | `{"schemaVersion":1, "generatedAt", "sourceStatus":[{id, ok, count, error?, carriedForward?}], "items":[ContentItem…]}`, written compactly |
| `status.json` | Readable summary of the feed run: counts, failures and the file size |
| `law-library.json` | `{"schemaVersion":1, "generatedAt", "status", "updates":[section…], "juryInstructions":[doc…], "statutes":{"PEN-187":{…}}, "rules":{"8.1105":{…}}}` |
| `law-status.json` | Readable summary of the law run, including which statutes and rules failed |
| `index.html` | A small page explaining what this site is |

Each item in `feed.json` uses the iOS `ContentItem` fields: `id, title,
subtitle, summary, category, kind, source, url, tags, readTime, era,
publishedAt (ISO-8601 or null), locationName, latitude, longitude,
isDynamic`, plus `sourceId` (the `feeds.json` id).

### Editing the lists

- **Feeds:** edit `feeds.json` on github.com (click the file, then the pencil
  icon). This is the same list the iOS app uses.
- **Statutes:** `scripts/statute-list.json` lists each section as `lawCode`
  plus `section`. It holds a curated core list plus every leginfo section
  referenced in the app's MCQ bank (`hiculture_law_mcq_bank_v2.json`, as of
  2026-10-21). If the bank gains new references, add them here.
- **Rules of Court:** `scripts/rule-list.json`.

---

## Troubleshooting

- **Feeds stopped updating.** GitHub turns off scheduled jobs in a repo with
  no activity for 60 days. The nightly job commits new data every night, which
  counts as activity, so this normally never happens. If it does, open
  **Actions → Refresh HiCulture feeds** and click **Enable workflow**, then
  **Run workflow**.
- **A run shows a red X.** Click the run and open the step that failed. Any
  data that did refresh is still committed. Check `status.json` and
  `law-status.json` for the failing sources.
- **Some feeds always fail.** A few publishers block automated requests
  (HTTP 403) or are down for a while (HTTP 5xx). Their last good items are
  kept. They stay in `feeds.json` because the iOS app uses the same list.
- **Statutes are empty.** leginfo.legislature.ca.gov is behind a Cloudflare
  "Just a moment…" check that only real browsers pass. It blocked both the
  app's User-Agent and a browser-like one when this was built. After 3 blocks
  in a row, the script stops asking for the rest of that run. Rules of Court,
  law updates and jury instructions come from courts.ca.gov, which works.
- **Updating the job after a change.** Upload the changed file again with
  **Add file → Upload files**, using the same path. GitHub replaces it.

## Running it on a Mac (optional)

With Node.js 20 or newer installed, from this folder:

```sh
node scripts/refresh.mjs        # writes docs/feed.json and docs/status.json
node scripts/law-library.mjs    # writes docs/law-library.json and docs/law-status.json
FORCE_LAW_REFRESH=1 node scripts/law-library.mjs   # refetch all statutes/rules now
```

Neither script needs anything installed with npm.
