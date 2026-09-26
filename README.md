# mustafa-website — YouTube Downloader

Webapp om YouTube-video's als **MP4** of **MP3** te downloaden. Het downloaden
gebeurt server-side met [yt-dlp](https://github.com/yt-dlp/yt-dlp) + `ffmpeg`, dus
je browser krijgt gewoon een bestand aangeleverd.

Live: **https://mustafa.sdai.nl** · IDE: **https://ide-mustafa.sdai.nl**

## Wat de app doet

- Link plakken → preview met titel, kanaal, duur, aantal views en thumbnail.
- **Video**: MP4 (H.264/AAC, speelt overal) tot 1080p, of "best beschikbaar".
- **Audio**: MP3 van 128 t/m 320 kbps (met metadata).
- Live voortgangsbalk (server-sent events: percentage, snelheid, ETA, grootte).
- Max **2 gelijktijdige** downloads; de rest wacht in de wachtrij.
- Klaar? Het bestand wordt automatisch in je browser opgeslagen.
- Alleen YouTube-links (`youtube.com`, `youtu.be`, `/shorts/`), tenzij je
  `ALLOW_ANY_URL=1` zet.

## Snel starten

```bash
cd /workspace/mustafa-website
npm run setup     # haalt de yt-dlp binary op in .tools/ (eenmalig, ~30 MB)
npm start         # = node server.js op 0.0.0.0:3000
```

Daarna: http://localhost:3000 of https://mustafa.sdai.nl.

De container start de app ook automatisch: supervisord (`serve-app.sh`) draait
`node server.js` op poort 3000 en zet dat via nginx door. Ontbreekt `yt-dlp`, dan
haalt de server die bij het opstarten zelf op de achtergrond op — je hoeft dus
niets te doen. Vereist: Node ≥ 18 en `ffmpeg` in het `PATH` (beide aanwezig).

## Configuratie (omgevingsvariabelen)

| Variabele | Default | Betekenis |
| --- | --- | --- |
| `PORT` | `3000` | Poort waarop geluisterd wordt (`0.0.0.0`). |
| `YTDLP_PATH` | `.tools/yt-dlp` | Eigen yt-dlp binary gebruiken. |
| `YTDLP_COOKIES` | – | Pad naar `cookies.txt` voor leeftijds-/login-restricties. |
| `ALLOW_ANY_URL` | `0` | `1` = elke door yt-dlp ondersteunde site toestaan. |
| `MAX_CONCURRENT_DOWNLOADS` | `2` | Gelijktijdige yt-dlp-processen (beschermt de container). |
| `MAX_ACTIVE_DOWNLOADS` | `24` | Maximaal aantal jobs in de wachtrij. |
| `JOB_TTL_MS` | `1800000` | Hoe lang een klaar bestand bewaard blijft (30 min). |

## API

| Endpoint | Wat het doet |
| --- | --- |
| `GET /api/health` | yt-dlp-versie, ffmpeg aanwezig?, cookies geladen. |
| `POST /api/info` `{url}` | Metadata + beschikbare kwaliteiten en geschatte groottes. |
| `POST /api/download` `{url,mode,quality,info}` | Zet een job in de wachtrij → `202` met job-id. |
| `GET /api/status/:id` | Huidige status/voortgang van een job (JSON). |
| `GET /api/progress/:id` | Zelfde, als SSE-stream (eerst een snapshot, dan updates). |
| `POST /api/cancel/:id` | Job annuleren (stopt ook het yt-dlp-proces). |
| `GET /api/file/:id` | Het eindbestand downloaden (`Content-Disposition: attachment`). |

`mode` is `video` of `audio`; `quality` is `best|1080|720|480|360` voor video en
`320|256|192|128` voor audio.

```bash
curl -s -X POST localhost:3000/api/info \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=aqz-KE-bpKQ"}'

curl -s -X POST localhost:3000/api/download \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=aqz-KE-bpKQ","mode":"audio","quality":"192"}'
```

## Bestanden in dit project

```
server.js          HTTP-server: statische bestanden uit public/ + JSON/SSE-API
lib/ytdlp.js       yt-dlp-wrapper: URL-validatie, metadata, argumenten, voortgang
lib/jobs.js        wachtrij, statussen, SSE-clients, opruimen van tijdelijke bestanden
public/index.html  de pagina
public/app.js      front-end (preview, tabs, voortgang, automatisch opslaan)
public/styles.css  dark glassmorphism-thema
scripts/setup.js   haalt de standalone yt-dlp binary op in .tools/
.tools/            yt-dlp binary (niet in git)
```

## Onderhoud

```bash
npm run setup -- --force          # yt-dlp bijwerken naar de nieuwste versie
sudo supervisorctl restart appserver
sudo supervisorctl status appserver
```

## Let op

- Download alleen video's waar je de rechten voor hebt en respecteer de
  YouTube-voorwaarden en het auteursrecht.
- Playlists worden niet ondersteund: er wordt één video per keer gedownload.
- Bestanden staan tijdelijk in `/tmp` en worden na `JOB_TTL_MS` verwijderd.
- Leeftijdsgebonden of alleen-voor-ingelogden video's werken alleen met een
  `cookies.txt` via `YTDLP_COOKIES` (dat bestand staat in `.gitignore`).

## Je werk opslaan (git push)

De container heeft schrijfrechten op deze repo via een deploy-key:

```bash
git add -A
git commit -m "beschrijf je wijziging"
git push
```

Repo: `git@github.com:sayfjawad/mustafa-website.git`
