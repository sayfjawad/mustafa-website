"use strict";

// YouTube downloader — zero-dependency Node server.
//
// Serves ./public plus a small JSON + SSE API around yt-dlp.
// Binds to 0.0.0.0:3000 so nginx can publish it at https://mustafa.sdai.nl

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ytdlp = require("./lib/ytdlp");
const jobs = require("./lib/jobs");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 16 * 1024;

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const MEDIA_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".opus": "audio/opus",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};

let ytdlpInfo = null; // cached result of the yt-dlp / ffmpeg probe

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res, err) {
  const status = Number(err && err.status) || 500;
  const message = (err && err.message) || "Unexpected server error.";
  if (status >= 500) console.error("[api]", message);
  sendJson(res, status, { error: message });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(ytdlp.fail("Request body is too large.", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => reject(ytdlp.fail("Could not read the request body.", 400)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(ytdlp.fail("Request body must be valid JSON.", 400));
      }
    });
  });
}

function contentDisposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function serveStatic(res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.join(PUBLIC_DIR, path.normalize(relative));

  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Forbidden");
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      return res.end("<h1>404 — Not Found</h1>");
    }
    const extension = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": STATIC_TYPES[extension] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=300",
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

const VIDEO_QUALITIES = ["best", "1080", "720", "480", "360"];
const AUDIO_BITRATES = ["320", "256", "192", "128"];

function normaliseOptions(body) {
  const mode = body.mode === "audio" ? "audio" : "video";
  const requested = String(body.quality ?? "");
  if (mode === "audio") {
    return { mode, quality: AUDIO_BITRATES.includes(requested) ? requested : "192" };
  }
  return { mode, quality: VIDEO_QUALITIES.includes(requested) ? requested : "best" };
}

/** Server-sent events with a snapshot first, so late subscribers are in sync. */
function streamProgress(id, req, res) {
  const job = jobs.get(id);
  if (!job) return sendJson(res, 404, { error: "That download is unknown or has expired." });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  if (typeof ping.unref === "function") ping.unref();

  const client = {
    send: (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`),
    end: () => {
      clearInterval(ping);
      res.end();
    },
  };

  const off = jobs.addClient(job, client);
  client.send(jobs.publicJob(job));

  req.on("close", () => {
    clearInterval(ping);
    off();
  });
}

function sendJobFile(id, req, res) {
  const job = jobs.deliverable(id);
  const stat = fs.statSync(job.filePath);
  const extension = path.extname(job.filename).toLowerCase();

  res.writeHead(200, {
    "Content-Type": MEDIA_TYPES[extension] || "application/octet-stream",
    "Content-Length": stat.size,
    "Content-Disposition": contentDisposition(job.filename),
    "Cache-Control": "no-store",
  });

  const stream = fs.createReadStream(job.filePath);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  res.on("finish", () => jobs.markDelivered(job));
  stream.pipe(res);
}

async function handleApi(req, res, url) {
  const method = req.method || "GET";
  const { pathname } = url;

  if (method === "OPTIONS") {
    res.writeHead(204, {
      Allow: "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  if (pathname === "/api/health" && method === "GET") {
    if (!ytdlpInfo || !ytdlpInfo.installed) ytdlpInfo = await ytdlp.probe();
    return sendJson(res, 200, { ...ytdlpInfo, maxConcurrent: jobs.MAX_CONCURRENT });
  }

  if (pathname === "/api/info" && method === "POST") {
    const body = await readJsonBody(req);
    return sendJson(res, 200, await ytdlp.fetchInfo(body.url));
  }

  if (pathname === "/api/download" && method === "POST") {
    const body = await readJsonBody(req);
    const { url, mode, quality } = {
      url: ytdlp.parseUrl(body.url).toString(),
      ...normaliseOptions(body),
    };
    const job = jobs.create({ url, mode, quality, info: body.info });
    return sendJson(res, 202, jobs.publicJob(job));
  }

  const route = /^\/api\/(status|progress|cancel|file)\/([A-Za-z0-9_-]{4,64})$/.exec(pathname);
  if (route) {
    const [, action, id] = route;
    if (action === "status" && method === "GET") return sendJson(res, 200, jobs.snapshot(id));
    if (action === "progress" && method === "GET") return streamProgress(id, req, res);
    if (action === "cancel" && (method === "POST" || method === "DELETE")) {
      return sendJson(res, 200, await jobs.cancel(id));
    }
    if (action === "file" && method === "GET") return sendJobFile(id, req, res);
  }

  return sendJson(res, 404, { error: "Unknown API endpoint." });
}

/* ------------------------------------------------------------------ *
 * server
 * ------------------------------------------------------------------ */

/**
 * A fresh clone can be started straight with `node server.js` (that is what
 * supervisord does), skipping npm's prestart hook — so fetch the yt-dlp binary
 * in the background when it is missing. /api/health re-probes every request,
 * so the UI turns green as soon as the download finishes.
 */
function bootstrapYtdlp() {
  const script = path.join(__dirname, "scripts", "setup.js");
  if (!fs.existsSync(script)) return;
  console.log("[ytdl] downloading the yt-dlp binary (scripts/setup.js --optional)…");
  const child = spawn(process.execPath, [script, "--optional"], { stdio: "inherit" });
  child.on("error", (err) => console.log(`[ytdl] bootstrap failed: ${err.message}`));
  child.on("exit", (code) => console.log(`[ytdl] bootstrap finished (exit ${code})`));
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return sendJson(res, 400, { error: "Bad request." });
  }

  const handle = url.pathname.startsWith("/api/")
    ? handleApi(req, res, url)
    : Promise.resolve().then(() => serveStatic(res, url.pathname));

  Promise.resolve(handle).catch((err) => {
    if (!res.headersSent) return sendError(res, err);
    res.destroy();
  });
});

server.headersTimeout = 5 * 60 * 1000; // long downloads + SSE
server.requestTimeout = 0;
server.keepAliveTimeout = 65 * 1000;

jobs.startSweeper();

server.listen(PORT, "0.0.0.0", () => {
  ytdlp
    .probe()
    .then((info) => {
      ytdlpInfo = info;
      console.log(
        info.installed
          ? `[ytdl] yt-dlp ${info.version} (${info.path}) · ffmpeg ${info.ffmpeg ? "ok" : "missing"}`
          : `[ytdl] yt-dlp NOT available: ${info.error || "unknown reason"}`
      );
      if (!info.installed) {
        console.log("[ytdl] run `npm run setup` to download yt-dlp");
        bootstrapYtdlp();
      }
    })
    .catch(() => {});
  console.log(`mustafa-youtube-downloader serving on http://0.0.0.0:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    jobs.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

