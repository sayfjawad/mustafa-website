"use strict";

/**
 * Thin wrapper around the yt-dlp command line tool.
 *
 * Everything here is intentionally dependency-free: the yt-dlp binary is
 * downloaded into ./.tools by `npm run setup`, or picked up from PATH / the
 * YTDLP_PATH environment variable.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const IS_WIN = process.platform === "win32";
const LOCAL_BINARY = path.join(ROOT, ".tools", IS_WIN ? "yt-dlp.exe" : "yt-dlp");

// Only YouTube links are accepted so the server cannot be used as a generic
// proxy for arbitrary URLs. Set ALLOW_ANY_URL=1 to lift that restriction
// (yt-dlp supports plenty of other sites too).
const ALLOWED_HOSTS = ["youtube.com", "youtube-nocookie.com", "youtu.be", "yt.be"];
const ALLOW_ANY_URL = process.env.ALLOW_ANY_URL === "1";

const VIDEO_QUALITIES = ["best", "1080", "720", "480", "360"];
const STANDARD_HEIGHTS = [1080, 720, 480, 360];
const AUDIO_BITRATES = ["320", "256", "192", "128"];

// YouTube hands out different media URLs per "player client" and sometimes
// rejects the whole set of one client with "HTTP Error 403: Forbidden" while
// another client keeps working. When a download fails like that, the job runner
// retries it once per plan below. Every attempt re-extracts the video, so it
// also gets a brand new (not expired) media URL.
const RETRY_PLANS = [
  { label: "default player clients", args: [] },
  {
    label: "alternate player clients",
    args: ["--extractor-args", "youtube:player_client=visionos,ios,web_safari"],
  },
  {
    label: "alternate player clients + extra formats over IPv4",
    args: [
      "--extractor-args",
      "youtube:player_client=visionos,ios,web_safari",
      "--extractor-args",
      "youtube:formats=missing_pot",
      "--force-ipv4",
    ],
  },
];

/** Failures that are worth another attempt with a different client / new URL. */
const RETRYABLE_ERROR =
  /(403|forbidden|429|too many requests|50[0234]|connection|timed? ?out|timeout|temporarily|try again|unable to download video data|unable to download webpage|sign in to confirm|not a bot|po ?token|nsig|page needs to be reloaded|connection reset|eof occurred|broken pipe)/i;

/**
 * The plans to try, in order. Set `YTDLP_PLAYER_CLIENT` on the server (e.g.
 * `tv` or `visionos,ios`) to force a specific player client as first attempt.
 */
function downloadPlans() {
  const forced = String(process.env.YTDLP_PLAYER_CLIENT || "").trim();
  const plans = RETRY_PLANS.map((plan) => ({ label: plan.label, args: [...plan.args] }));
  if (forced) {
    plans.unshift({
      label: `YTDLP_PLAYER_CLIENT=${forced}`,
      args: ["--extractor-args", `youtube:player_client=${forced}`],
    });
  }
  return plans;
}

/** True when retrying with other player clients may actually help. */
function isRetryable(message) {
  return RETRYABLE_ERROR.test(String(message || ""));
}

/** Turns a raw yt-dlp error into something a visitor can act on. */
function friendlyError(message) {
  const text = String(message || "").trim();
  if (!text) return "The download failed. Please try again.";
  if (/403|forbidden/i.test(text)) {
    return (
      "YouTube refused to send the video data (HTTP 403) — it is temporarily blocking " +
      "this server for that video. We already retried with different player clients. " +
      "Please try again in a few minutes, or pick another quality."
    );
  }
  if (/sign in to confirm|not a bot|age.?restricted|cookies/i.test(text)) {
    return (
      "YouTube wants a signed-in session for this video. Put a cookies.txt on the " +
      "server and point YTDLP_COOKIES at it."
    );
  }
  if (/requested format is not available/i.test(text)) {
    return 'This video has no stream in the quality you picked. Choose another quality, or "Best available".';
  }
  if (/unavailable|private video|removed|deleted|does not exist|no longer/i.test(text)) {
    return "YouTube says this video is not available (private, removed or blocked in this region).";
  }
  if (/timed? ?out|took too long/i.test(text)) {
    return "YouTube did not answer in time. Please try again.";
  }
  return text;
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function binaryPath() {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  if (fs.existsSync(LOCAL_BINARY)) return LOCAL_BINARY;
  return IS_WIN ? "yt-dlp.exe" : "yt-dlp";
}

function cookieArgs() {
  const file = process.env.YTDLP_COOKIES || path.join(ROOT, "cookies.txt");
  return fs.existsSync(file) ? ["--cookies", file] : [];
}

function baseArgs() {
  return [
    "--ignore-config",
    "--no-playlist",
    "--newline",
    "--no-color",
    "--retries",
    "5",
    "--fragment-retries",
    "5",
    "--socket-timeout",
    "20",
    ...cookieArgs(),
  ];
}

/* ------------------------------------------------------------------ *
 * input validation
 * ------------------------------------------------------------------ */

function isAllowedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function parseUrl(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw fail("Paste a YouTube link first.");
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw fail("That does not look like a valid link.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw fail("Only http(s) links are supported.");
  }
  if (!ALLOW_ANY_URL && !isAllowedHost(url.hostname)) {
    throw fail("Only YouTube links are supported (youtube.com, youtu.be).");
  }
  return url;
}

/* ------------------------------------------------------------------ *
 * formatting helpers
 * ------------------------------------------------------------------ */

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function cleanError(stderr) {
  const lines = String(stderr || "")
    .split("\n")
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter((line) => /^ERROR:/i.test(line));
  if (!lines.length) return "";
  return lines[lines.length - 1].replace(/^ERROR:\s*/i, "");
}

/* ------------------------------------------------------------------ *
 * low level execution
 * ------------------------------------------------------------------ */

function run(args, { timeoutMs = 60000, maxOutput = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = binaryPath();
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return reject(fail(`${bin} could not be started (${err.message}).`, 503));
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < maxOutput) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        return reject(
          fail("yt-dlp is not installed on the server. Run `npm run setup` (or set YTDLP_PATH).", 503)
        );
      }
      reject(fail(`Failed to run yt-dlp: ${err.message}`, 500));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(fail("YouTube took too long to answer. Please try again.", 504));
      }
      if (code !== 0) {
        return reject(fail(cleanError(stderr) || `yt-dlp exited with code ${code}.`, 502));
      }
      resolve({ stdout, stderr });
    });
  });
}

/** Version + availability of the tools behind the app (used by /api/health). */
async function probe() {
  const bin = binaryPath();
  const info = { installed: false, version: null, path: bin, ffmpeg: false, cookies: false };
  try {
    const { stdout } = await run(["--version"], { timeoutMs: 20000 });
    info.installed = true;
    info.version = stdout.trim();
  } catch (err) {
    info.error = err.message;
  }
  info.cookies = cookieArgs().length > 0;
  info.ffmpeg = await new Promise((resolve) => {
    const ffmpeg = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    ffmpeg.on("error", () => resolve(false));
    ffmpeg.on("close", (code) => resolve(code === 0));
  });
  return info;
}

/* ------------------------------------------------------------------ *
 * metadata
 * ------------------------------------------------------------------ */

function pickThumbnail(data) {
  if (data.thumbnail) return data.thumbnail;
  const list = (Array.isArray(data.thumbnails) ? data.thumbnails : []).filter((t) => t && t.url);
  if (!list.length) return null;
  // prefer a reasonably large thumbnail, otherwise the biggest one available
  const sorted = list.slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((t) => (t.width || 0) >= 480) || sorted[sorted.length - 1]).url;
}

function maxHeight(data) {
  return (Array.isArray(data.formats) ? data.formats : []).reduce((max, f) => {
    if (!f || f.vcodec === "none" || !f.height) return max;
    return Math.max(max, f.height);
  }, 0);
}

/** Rough size per quality, so the UI can show "≈ 12 MiB" next to each option. */
function sizesFor(data, heights) {
  const formats = (data.formats || []).filter(Boolean);
  const videos = formats.filter((f) => f.vcodec && f.vcodec !== "none" && f.height);
  const audio = formats
    .filter((f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"))
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];

  const seconds = Number(data.duration) || 0;
  // DASH formats often report no filesize; estimate from the bitrate instead.
  const fileSize = (format) => {
    if (!format) return 0;
    const exact = format.filesize || format.filesize_approx;
    if (exact) return exact;
    const tbr = Number(format.tbr) || Number(format.abr) || 0;
    return tbr > 0 && seconds > 0 ? Math.round((tbr * 1000 * seconds) / 8) : 0;
  };
  const bestVideo = (limit) =>
    videos
      .filter((f) => (limit ? f.height <= limit : true))
      .sort((a, b) => {
        if (b.height !== a.height) return b.height - a.height;
        return (/^avc1|^h264/i.test(b.vcodec) ? 1 : 0) - (/^avc1|^h264/i.test(a.vcodec) ? 1 : 0);
      })[0];

  const sizes = {};
  for (const quality of heights) {
    const limit = quality === "best" ? null : Number(quality);
    const total = fileSize(bestVideo(limit)) + fileSize(audio);
    sizes[quality] = total > 0 ? total : null;
  }
  return sizes;
}

async function fetchInfo(rawUrl) {
  const url = parseUrl(rawUrl);
  const { stdout } = await run(
    [...baseArgs(), "--dump-single-json", "--no-progress", url.toString()],
    { timeoutMs: 90000 }
  );

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw fail("Could not read the video details from YouTube.", 502);
  }

  if (data._type === "playlist") {
    const first = (data.entries || []).find(Boolean);
    if (!first) throw fail("That link does not contain a playable video.", 400);
    data = first;
  }

  const top = maxHeight(data);
  const heights = ["best", ...STANDARD_HEIGHTS.filter((height) => top >= height)];
  if (heights.length === 1) heights.push("360"); // always offer at least one capped option

  const duration = Number(data.duration) || null;

  return {
    id: data.id || null,
    title: data.title || "Untitled",
    uploader: data.uploader || data.channel || null,
    duration,
    durationText: formatDuration(duration),
    thumbnail: pickThumbnail(data),
    webpageUrl: data.webpage_url || url.toString(),
    viewCount: Number.isFinite(data.view_count) ? data.view_count : null,
    isLive: Boolean(data.is_live),
    maxHeight: top || null,
    qualities: heights,
    sizes: sizesFor(data, heights),
    audioSizes: duration
      ? AUDIO_BITRATES.reduce((acc, kbps) => {
          acc[kbps] = Math.round((Number(kbps) * 1000 * duration) / 8);
          return acc;
        }, {})
      : {},
  };
}

/* ------------------------------------------------------------------ *
 * downloading
 * ------------------------------------------------------------------ */

/**
 * Format selector for video downloads: H.264/AAC MP4 first (plays
 * everywhere), then any MP4, then whatever YouTube hands us.
 */
function videoFormat(height) {
  const cap = height ? `[height<=${height}]` : "";
  return [
    `bv*${cap}[vcodec^=avc1]+ba[acodec^=mp4a]`,
    `bv*${cap}[ext=mp4]+ba[ext=m4a]`,
    `bv*${cap}+ba`,
    `b${cap}`,
    "bv*+ba/b",
  ].join("/");
}

function buildDownloadArgs({ url, mode, quality, dir, extraArgs = [] }) {
  const args = [
    ...baseArgs(),
    ...extraArgs,
    "-o",
    path.join(dir, "%(title).100B [%(id)s].%(ext)s"),
  ];

  if (mode === "audio") {
    const bitrate = AUDIO_BITRATES.includes(String(quality)) ? String(quality) : "192";
    args.push(
      "-f",
      "ba[acodec^=mp4a]/ba/b",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      `${bitrate}K`,
      "--embed-metadata"
    );
  } else {
    const capped = quality !== "best" && VIDEO_QUALITIES.includes(String(quality));
    args.push(
      "-f",
      videoFormat(capped ? String(quality) : null),
      "--merge-output-format",
      "mp4/mkv",
      "--embed-metadata"
    );
  }

  args.push("--", url);
  return args;
}

/** Turns one yt-dlp output line into a small event object. */
function parseLine(line) {
  const destination = /^\[download\]\s+Destination:\s*(.+)$/.exec(line);
  if (destination) return { type: "file", file: path.basename(destination[1]) };

  const progress = /^\[download\]\s+([\d.]+)%/.exec(line);
  if (progress) {
    const size = /of\s+~?\s*([\d.]+\s*[KMGTP]?i?B)/.exec(line);
    const speed = /at\s+([\d.]+\s*[KMGTP]?i?B\/s)/.exec(line);
    const eta = /ETA\s+(\d+(?::\d+)+|Unknown|--:--)/.exec(line);
    return {
      type: "progress",
      percent: Number(progress[1]),
      sizeText: size ? size[1] : null,
      speed: speed ? speed[1] : null,
      eta: eta && /^[\d:]/.test(eta[1]) ? eta[1] : null,
    };
  }

  if (/^\[(Merger|ExtractAudio|ffmpeg|FixupM\w*|Metadata)\]/i.test(line)) {
    const quoted = /"([^"]+)"/.exec(line);
    return {
      type: "processing",
      file: quoted ? path.basename(quoted[1]) : null,
      message: line.replace(/^\[[^\]]+\]\s*/, ""),
    };
  }

  if (/^ERROR:/i.test(line)) return { type: "error", message: line.replace(/^ERROR:\s*/i, "") };

  return { type: "log", message: line };
}

/**
 * Starts a download inside its own temp directory.
 * `extraArgs` are appended to the command line (used for the retry plans).
 * Returns { child, args, errors, warnings, done }; `done` resolves once
 * yt-dlp exits.
 */
function startDownload({ url, mode, quality, dir, extraArgs = [], onEvent }) {
  const args = buildDownloadArgs({ url, mode, quality, dir, extraArgs });
  const child = spawn(binaryPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
  const errors = [];
  const warnings = [];
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const event = parseLine(line);
      if (event.type === "error") errors.push(event.message);
      onEvent(event);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    for (const raw of String(chunk).split("\n")) {
      const line = raw.replace(/\u001b\[[0-9;]*m/g, "").trim();
      if (!line) continue;
      if (/^ERROR:/i.test(line)) errors.push(line.replace(/^ERROR:\s*/i, ""));
      else if (/^WARNING:/i.test(line)) warnings.push(line.replace(/^WARNING:\s*/i, ""));
    }
  });

  const done = new Promise((resolve) => {
    child.on("error", (error) => resolve({ error, code: null, errors, warnings }));
    child.on("close", (code, signal) => resolve({ code, signal, errors, warnings }));
  });

  return { child, args, errors, done };
}

/** Finds the finished media file inside a job directory. */
async function pickArtifact(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  let best = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (/\.(part|ytdl|temp|tmp)$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const stat = await fs.promises.stat(full).catch(() => null);
    if (!stat || stat.size === 0) continue;
    if (!best || stat.size > best.size) best = { name: entry.name, path: full, size: stat.size };
  }
  return best;
}

module.exports = {
  ALLOWED_HOSTS,
  AUDIO_BITRATES,
  VIDEO_QUALITIES,
  binaryPath,
  buildDownloadArgs,
  downloadPlans,
  fail,
  fetchInfo,
  formatDuration,
  friendlyError,
  humanBytes,
  isRetryable,
  parseLine,
  parseUrl,
  pickArtifact,
  probe,
  startDownload,
  videoFormat,
};



