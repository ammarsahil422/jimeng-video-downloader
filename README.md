# Jimeng Video Downloader — Standalone Deployable Version

Paste a public Jimeng / Dreamina share link, get the original MP4 **without
watermark**. Same site as the Muse-app version, rewritten to run on your own
server so downloads work in a real browser.

**Why a standalone version exists:** the site previously ran only inside the
Muse app, which has no real web link and whose built-in view blocks file
downloads — the Download button did nothing there, every time, no matter how
it was rebuilt. On your own server, in a real browser (Chrome on your phone
or on a computer), the same Download button saves the file normally.

## What this package is

- **Client:** the same React site (downloader, preview, quality list,
  download history, optional API-key box, AdSense-ready slots, About /
  Privacy Policy / Contact pages), with a side menu (☰ Menu: Jimeng
  Downloader, Download History, What is Jimeng?, How to Use, FAQ, Bulk
  Download, Contact, About, Privacy Policy), a separate Download History
  page, and Bulk Download (up to 10 links at once). The whole interface
  is in English. Prebuilt in `public/` — it runs as-is.
  Source is in `client/` if you ever want to change the design.
- **Server:** `server/server.ts` (Bun). It serves the client, answers the
  site's actions (`POST /actions`), and serves prepared downloads from
  `/blobs/<key>`.
- **Storage:** a plain SQLite file (`data/app.db`, created on first run) for
  settings, download history and contact messages; downloaded videos are
  cached on disk under `data/files/` (oldest deleted first after 5 GB —
  change with `MAX_CACHE_BYTES`).
- **No Hatch SDK, no external services, no npm runtime dependencies.**
  The server needs only Bun. The client build needs `bun install` once.

### What changed vs the hosted (Muse-app) version

- Database: Hatch `ctx.db` (Drizzle) → plain SQLite file via `bun:sqlite`
  (`server/db.ts`, same tables).
- File storage: Hatch `ctx.blobs` → local disk (`server/files.ts`,
  `data/files/`).
- Actions: Hatch `defineAction` → plain HTTP `POST /actions`
  (`server/handlers.ts`).
- Client transport: `@hatch/space-sdk/client` → plain `fetch`
  (`client/src/api.ts`).
- Download URL: `./blobs/<key>` (same as before — now served from this
  server, with `Content-Disposition: attachment` so a real browser saves
  it, plus Range support).

Behaviour is unchanged: the resolver still uses Jimeng's `mget_item_info`
endpoint first, which returns the **clean master file** (no AI badge,
no Jimeng @user watermark, no appended Jimeng ending card), with
`get_item_info` only as fallback. Clean files sort first in the quality
list; a watermarked display file is labelled "File with watermark", never
"No Watermark". One small hardening was added while testing this package:
the item-API calls retry once on a transient timeout, because a single
timeout used to silently drop the resolver to the watermarked fallback file.

### What's new in this update (19 Nov 2026)

This package now matches the latest Muse-app version:

- **Side menu:** the ☰ Menu drawer (Jimeng Downloader, Download History,
  What is Jimeng?, How to Use, FAQ, Bulk Download, Contact, About,
  Privacy Policy). Download History moved off the home page into its own
  page (with Download again / Remove buttons).
- **Bulk Download:** paste up to 10 Jimeng links (one per line); each is
  resolved in turn with its own Download button.
- **Sora Downloader** is listed in the menu only as "Coming Soon" — there
  is no Sora resolver in this package.
- **Full English interface:** every button, label, note and error message
  is in English ("Download Now", "Share and Save", "Open file in new
  tab", "My Download History", "Download again", "Remove", "Clear",
  "Go to Jimeng Downloader"). Videos' own titles from Jimeng are
  unchanged — they are the videos' data, not interface text.
- **How to Use** now also documents the phone method the user found:
  on the playing video, tap the three dots (⋮) → Share → Save at the
  end of the share sheet, and the video saves to the gallery.
- **Admin Panel (admin-only login):** downloads stay public — no login,
  no user accounts. The sidebar has a Login item; entering the admin
  email/password opens the Admin Panel with Dashboard (downloads today /
  total, storage used, recent downloads), Ads (the AdSense slots moved
  here — they no longer appear on the public site), API Key settings,
  and Settings (change the admin password, shows the admin email). The
  admin account is seeded automatically on first boot
  (`admin@jimengdownloader.com`); the password is set by the site owner
  and is not written in this repo. On Render Free the database resets
  on restart/redeploy, so the admin account is re-seeded on every boot
  and the same admin login keeps working.

## What you need

A server that can run a program (Bun + SQLite) — **not** static-only
hosting. A plain HTML host cannot run the resolver or prepare downloads.
Any small Ubuntu VPS works. Minimum that is comfortable: **1 vCPU, 1 GB
RAM, 25 GB disk**.

---

## Path A — You have nothing yet: domain + server from zero (simplest route)

You need two things, bought once from two websites. Nothing is bought for
you here — do these steps yourself on the official sites.

### Step 1 — Buy a domain (~$11/year)

Go to **porkbun.com**, search for a name you like (for example
`jimengdownloader.com` — any free name works, `.com` is the safe choice),
and buy it for **1 year**.

- Price checked 17 Nov 2026: **$11.81 per year for a `.com`**
  (registration, renewal and transfer are all $11.81), with free WHOIS
  privacy included. Porkbun raised it from $11.08 on 1 Nov 2026, when
  Verisign raised the wholesale .com fee — so it is no longer $11.08.
  That is still why Porkbun is the pick: Namecheap's `.com` looks cheap
  in year one but renews at about $18.48, and Cloudflare Registrar sells
  at cost, so about the same (~$11.17/year) but needs a Cloudflare
  account and Cloudflare nameservers. **Always confirm the price in
  your cart before paying — prices change.**
- You only need the domain name itself. Say no to every add-on at checkout
  (hosting, email, SSL, "privacy protection" — privacy is already free at
  Porkbun).

### Step 2 — Rent a small server (~$6/month)

Go to **digitalocean.com** and create an account, then create a **Droplet**
(server) with these choices:

- **Image:** Ubuntu 24.04 LTS (or 22.04 LTS)
- **Plan:** Basic, **$6/month** — 1 vCPU, 1 GB RAM, 25 GB SSD, 1 TB
  transfer. (There is also a $4/month plan with 512 MB RAM, but that is
  tight for Bun plus video caching — the $6 plan is the one to get.)
- **Region:** whichever is closest to you (for example Frankfurt or
  Singapore). It does not matter much for this site.
- **Authentication:** choose **Password** and set a strong password you
  will remember (you need it to log in to the server), or SSH key if you
  already have one.
- Prices checked 17 Nov 2026 from DigitalOcean's pricing page: $4 and $6
  Basic Droplets. Billing is hourly with a monthly cap, so you never pay
  more than the monthly price. **Confirm the price on the create page
  before you finish.**
- When the Droplet is ready, DigitalOcean shows you its **IPv4 address**
  (something like `164.90.123.45`). Write it down — you need it in Step 3
  and Step 4.

**Cheaper, more powerful alternative (optional):** Hetzner Cloud's CX23 —
about **€5.49/month + ~€0.50/month for the IPv4 address** (EU locations),
with 2 vCPUs, 4 GB RAM, 40 GB NVMe and 20 TB of traffic. That is more
server for about the same money, but the price **excludes VAT** (add
roughly 19% in the EU), Hetzner repriced its cloud servers twice in 2026
and replaced the old CX22 with the CX23, and signup sometimes asks for ID
verification. If you pick Hetzner, check the live price at
hetzner.com/cloud before buying. DigitalOcean is the simpler choice if
you just want it to work.

**Total from zero:** about **$6/month for the server + about $11.81/year for
the domain** (roughly $84 for the first year).

### Step 3 — Point the domain at the server (DNS)

1. Log in to **Porkbun** → **Domain Management** → click your domain →
   **DNS** (or "DNS Records").
2. Delete any existing `A` records for `@` if Porkbun parked the domain
   with its own page (leave the `CNAME`/`MX` records alone unless you know
   what they are — a fresh domain usually has none that matter).
3. Add an **A record**: Host `@`, Value = your server's IPv4 address from
   Step 2, TTL 600 (or leave default). This makes `yourdomain.com` point
   at the server.
4. Add another **A record**: Host `www`, Value = the same IPv4 address.
   This makes `www.yourdomain.com` work too.
5. Save. DNS takes a few minutes to a few hours to spread around the
   world — if the domain does not open straight away, wait an hour and
   try again. (You can still test the site immediately at
   `http://YOUR-SERVER-IP:3000` — see Step 4.)

### Step 4 — Put this site on the server

Continue with **Path B** below, starting at "2. Copy this folder to the
server". Your server's IPv4 address is the one from Step 2.

---

## Path B — Deploy on a server you already have

### 1. Install Bun on the server

Log in to the server (DigitalOcean's web console, or PuTTY / any SSH app
from your phone or computer) and run:

```bash
sudo apt update && sudo apt install -y nodejs npm
sudo npm install -g bun
bun --version
```

You should see a version number (1.3 or newer). (Bun's own website also
offers a one-line install script — the npm route above is the one that
needs no extra download address.)

### 2. Copy this folder to the server

From your computer (or with any file-transfer app), copy this whole
folder to the server, for example to
`/home/ubuntu/jimeng-video-downloader-standalone`.
With `scp` from a computer it looks like this (replace `YOUR-SERVER-IP`):

```bash
scp -r jimeng-video-downloader-standalone ubuntu@YOUR-SERVER-IP:/home/ubuntu/
```

Then log in to the server and go into the folder:

```bash
cd /home/ubuntu/jimeng-video-downloader-standalone
```

### 3. Install dependencies and start the site

```bash
bun install
bun run start
```

That is all. The client is already built (`public/` is included), so
there is nothing else to build. You should see a line saying the server
is running on port 3000, and a line showing where the data lives
(`.../data`, with `app.db` and cached files inside).

Open `YOUR-SERVER-IP:3000` in a browser — the site should load.
Press `Ctrl+C` to stop it for now; the next step makes it run
permanently.

> **Port:** the site listens on port **3000** by default. Change it with
> `PORT=8080 bun run start`, or set it in `.env` (copy `.env.example`
> to `.env` first). If you use the nginx setup below, keep port 3000.

### 4. Keep it running after you log out (systemd)

```bash
sudo cp jimeng-downloader.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jimeng-downloader
sudo systemctl status jimeng-downloader
```

Edit the two marked lines in `jimeng-downloader.service` first if your
username or folder is different from `ubuntu` /
`/home/ubuntu/jimeng-video-downloader-standalone`. Logs:
`sudo journalctl -u jimeng-downloader -f`.

### 5. (Optional) Use your domain with HTTPS

Without this, the site works at `YOUR-SERVER-IP:3000`. With it,
it works at `yourdomain.com` over HTTPS.

```bash
sudo apt install -y nginx
sudo cp nginx.conf.example /etc/nginx/sites-available/jimeng-downloader
# Edit server_name in that file to your real domain, then:
sudo ln -s /etc/nginx/sites-available/jimeng-downloader /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
# Free HTTPS certificate:
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

## Path C — Deploy on Render (free, no card needed)

If you do not want to rent a server, Render's free tier runs this same
package — no credit card needed, and you get a free
`https://<name>.onrender.com` address. The only files Render needs are
already in this folder: `Dockerfile` and `render.yaml`. Nothing about
the site itself changes.

### 1. Push this folder to a GitHub repo

Render deploys from GitHub. Create a new repo (public or private) and
push this whole folder into it:

```bash
cd <this folder>
git init
git add .
git commit -m "Jimeng Video Downloader"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

(Do not commit `data/` or `.env` — both are already in `.gitignore`.
Your download history stays on the server, not in the repo.)

### 2. Create the service on Render

1. Go to [dashboard.render.com](https://dashboard.render.com) and sign
   in (email only — no card needed for the free plan).
2. **New → Web Service** → pick your GitHub repo.
3. Runtime: **Docker** (Render detects the `Dockerfile`). Plan:
   **Free**. Region: Frankfurt (already in `render.yaml`).
4. Click **Create Web Service**. Render builds the image (a few
   minutes the first time) and starts the site.
5. Your site is live at `https://jimeng-video-downloader.onrender.com`
   (the exact address is the service name you chose).

Or use the blueprint: **New → Blueprint** → pick the repo — Render
reads `render.yaml` and creates the same service. `render.yaml` has
`autoDeploy: true`, so every push to GitHub redeploys the site
automatically.

### 3. Use your own domain (optional, free)

In Render: service → **Settings → Custom Domains** → **Add Custom
Domain** → type your domain (for example `jimengdownloader.com`).
Render shows you a CNAME record to add at your domain registrar
(Porkbun → DNS). HTTPS is set up automatically. The free
`*.onrender.com` address keeps working too.

### 4. Two honest limits of the Render free plan

- **It sleeps after 15 minutes with no traffic.** The next visitor
  waits about a minute while it wakes up. To keep it awake, point a
  free uptime pinger (UptimeRobot or cron-job.org — no card needed) at
  your site's address every 10 minutes. Render gives 750 free hours a
  month and a month is 720–744 hours, so a pinged service stays up all
  month for free.
- **No persistent disk.** Download History, settings and cached video
  files live inside the container, so they **reset when the service
  restarts or redeploys**. Downloading itself works normally — paste a
  link, get the clean video, save it — only the saved history list does
  not survive a restart. The admin account is an exception by design:
  it is re-seeded on every boot, so the admin login always works.
  (On a VPS with a disk, Path A/B above, history is kept permanently.)

If you later move to a VPS (Path A/B) or Oracle Cloud, the same package
works there unchanged — just copy this folder to the server and follow
those steps. Nothing needs to be rebuilt for the move.

## Using the site

- **Download a video:** paste a public Jimeng share link (or the whole
  Chinese share text — the link is extracted from inside it), press
  "Get Video", pick a quality (clean Origin files come first), press
  "Download MP4", then press **"Download Now"** in the Save panel.
  In a real browser that saves the file to Downloads. On a phone, "Share
  and Save" hands the file to the system share sheet instead. Or, on the
  playing video itself, tap the three dots (⋮) → Share → Save at the end
  of the share sheet to save it straight to the gallery.
- **Bulk Download:** open it from the ☰ Menu, paste up to 10 links (one
  per line), and each video is resolved in turn with its own Download
  button.
- **History:** every successful resolve is saved in "My Download
  History" (open it from the ☰ Menu or the History button) and stays
  after a restart (SQLite). Old history rows from the
  Muse-app version are **not** copied over — this server starts with an
  empty history.
- **API key (optional, leave empty):** Jimeng has no official downloader
  API key and the site works without one. The key box is only for a
  third-party resolver service if you ever buy one. A key will **not**
  remove a watermark and will **not** fix a download.
- **Ads (AdSense):** the ad slots (Top Banner, In-Content, Sidebar,
  Bottom) and the Ads Setup section are in the site. Paste your own
  AdSense code there after Google approves your site. **No publisher ID
  or ad code is pre-filled.** Approval for a downloader / "no watermark"
  site is not guaranteed — Google may refuse it. The site works with or
  without ads.
- **Contact messages:** they are stored in the database. To read them on
  the server, run this in the folder:
  `sqlite3 data/app.db "SELECT id, name, email, message, datetime(created_at/1000, 'unixepoch') FROM contact_messages ORDER BY id DESC;"`

## Updating the site later

Copy the new version of this folder over the old one (keep your `data/`
folder — that is where history, settings and cached videos live), then:

```bash
bun install
bun run build      # rebuilds the client into public/ (only needed if the client changed)
sudo systemctl restart jimeng-downloader
```

## Backups

Back up `data/` — it holds `app.db` (settings, history, contact
messages) and `data/files/` (cached videos). Everything else in this
folder can be re-downloaded/rebuilt.

## Troubleshooting

- **Site does not open at `YOUR-SERVER-IP:3000`:** check the service is
  running (`sudo systemctl status jimeng-downloader`), and open port 3000
  in the server's firewall (DigitalOcean: Networking → Firewalls → add
  an inbound rule for TCP 3000; or `sudo ufw allow 3000/tcp`). If you use
  nginx + a domain, port 3000 does not need to be public at all.
- **A link resolves but the video will not download:** the file is first
  fetched from Jimeng's CDN by the server (this can take ~10 seconds for
  a 2–3 MB video). If it fails, resolve the link again — Jimeng's signed
  CDN links expire, so an old resolve cannot be downloaded later.
- **"Jimeng did not recognise this link's code (404)":** the share link
  expired or was copied incompletely. Copy a fresh link from the Jimeng
  app. Avatar / cast-template invite links expire after about 48 hours.
- **Only a "File with watermark" is offered:** Jimeng did not return a
  clean master for that video. Try the same link again later; do not
  paste a key — a key does not change this.

## Verification (done 17 Nov 2026, before this package was handed over)

The standalone server was run locally and tested end-to-end against a
real public Jimeng link from the site's own history,
`jimeng.jianying.com/s/f-SQrY1mR80/` (video "adegan yang sama hanya
ganti peran jadi semprul"):

- `resolveLink` returned **ok**, clean files first: **720p · Origin
  (No Watermark), 720×1254, 2,325,839 bytes** as the default, plus the
  clean Original master (8,159,416 bytes) and 720p/480p/360p clean
  transcodes. Resolve took ~4 s.
- `prepareDownload` on the default file returned **ok, 2,325,839 bytes**
  in ~11 s.
- Downloading through the server's own endpoint
  (`GET /blobs/jimeng-dl/…`) returned **exactly 2,325,839 bytes**,
  `Content-Type: video/mp4`, `Content-Disposition: attachment`, and a
  Range request returned **206 Partial Content**.
- `ffprobe` on the downloaded file: **720×1254, h264, 10.08 s** — exactly
  the video's real duration (the watermarked display file for the same
  video is 14.49 s because Jimeng appends an ending card). Frames at 2 s
  and 9.5 s were checked visually: real video content, **no AI badge,
  no Jimeng @user watermark, no ending card**.
- Download history was saved to the SQLite database and listed back
  correctly; the client page and its assets served with HTTP 200.

One honest caveat from testing: on the very first test run, one resolve
fell back to the watermarked display file because Jimeng's clean-file
endpoint timed out once right after a sandbox restart. The retry added
for that case fixed it in the re-test above, but if you ever see only a
"File with watermark" for a video, just resolve the same link again.

**Not verified here, and only you can confirm it:** that the Download
button saves the file on *your* phone after you deploy. That is the step
this whole package exists for — please test it on your phone once the
site is on your domain, and tell us if it saves or not.
