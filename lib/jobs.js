"use strict";

/**
 * In-memory download queue.
 *
 * Every download gets its own temp directory, a status object and a set of
 * connected browser clients. Finished jobs are removed - together with their
 * files - after a while, so the container never fills up.
 */

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const ytdlp = require("./ytdlp");

const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2));
const MAX_ACTIVE = Math.max(4, Number(process.env.MAX_ACTIVE_DOWNLOADS || 24));
const JOB_TTL_MS = Math.max(60000, Number(process.env.JOB_TTL_MS || 30 * 60 * 1000));
const MIN_BROADCAST_INTERVAL = 250;

const TERMINAL = new Set(["done", "error", "canceled", "delivered"]);

const jobs = new Map();
const pending = [];
let active = 0;

function fail(message, status = 400) {
  return ytdlp.fail(message, status);
}

function isRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null && !child.killed);
}

function publicJob(job) {
  const position = pending.indexOf(job);
  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    quality: job.quality,
    title: job.title,
    uploader: job.uploader,
    thumbnail: job.thumbnail,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    sizeText: job.sizeText,
    sizeBytes: job.sizeBytes,
    filename: job.filename,
    message: job.message,
    error: job.error,
    queuePosition: position >= 0 ? position + 1 : 0,
    createdAt: job.createdAt,
  };
}

function broadcast(job) {
  const payload = publicJob(job);
  for (const client of job.clients) {
    try {
      client.send(payload);
    } catch {
      job.clients.delete(client);
    }
  }
}

/** Merges a patch into the job state and (throttled) notifies the browsers. */
function emit(job, patch, { force = false } = {}) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  const terminal = TERMINAL.has(job.status);
  if (force || terminal || Date.now() - job.lastBroadcastAt >= MIN_BROADCAST_INTERVAL) {
    job.lastBroadcastAt = Date.now();
    broadcast(job);
  }
  if (terminal) endClients(job);
}

function endClients(job) {
  for (const client of job.clients) {
    try {
      client.end();
    } catch {
      /* ignore */
    }
  }
  job.clients.clear();
}

function addClient(job, client) {
  job.clients.add(client);
  return () => job.clients.delete(client);
}

function get(id) {
  return jobs.get(id) || null;
}

function list() {
  return [...jobs.values()].map(publicJob);
}

function snapshot(id) {
  const job = jobs.get(id);
  if (!job) throw fail("That download is unknown or has expired.", 404);
  return publicJob(job);
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

function create({ url, mode, quality, info }) {
  if (jobs.size >= MAX_ACTIVE) {
    throw fail("Too many downloads at the moment. Please try again in a minute.", 503);
  }

  const id = crypto.randomBytes(9).toString("hex");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdl-"));

  const job = {
    id,
    url,
    mode,
    quality,
    dir,
    status: "queued",
    title: (info && info.title) || null,
    uploader: (info && info.uploader) || null,
    thumbnail: (info && info.thumbnail) || null,
    percent: 0,
    speed: null,
    eta: null,
    sizeText: null,
    sizeBytes: null,
    filename: null,
    filePath: null,
    message: "Waiting in the queue…",
    error: null,
    parts: [],
    clients: new Set(),
    child: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastBroadcastAt: 0,
    deliveredAt: null,
  };

  jobs.set(id, job);
  pending.push(job);
  pump();
  return job;
}

function pump() {
  while (active < MAX_CONCURRENT && pending.length) {
    const job = pending.shift();
    if (job.status !== "queued") continue;
    active += 1;
    run(job)
      .catch(() => {})
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

/** Overall progress: parts already finished count as 100%. */
function overallPercent(job) {
  if (!job.parts.length) return 0;
  const completed = job.parts.length - 1;
  const current = job.parts[job.parts.length - 1];
  return Math.min(100, Math.round((completed * 100 + current) / (completed + 1)));
}

function applyEvent(job, event) {
  if (event.type === "file") {
    job.parts.push(0);
    emit(job, {
      status: "downloading",
      percent: overallPercent(job),
      message: job.parts.length > 1 ? `Downloading part ${job.parts.length}…` : "Downloading…",
    });
    return;
  }

  if (event.type === "progress") {
    if (!job.parts.length) job.parts.push(0);
    const index = job.parts.length - 1;
    job.parts[index] = Math.max(job.parts[index], event.percent);
    emit(job, {
      status: "downloading",
      percent: overallPercent(job),
      speed: event.speed,
      eta: event.eta,
      sizeText: event.sizeText || job.sizeText,
      message: job.parts.length > 1 ? `Downloading part ${job.parts.length}…` : "Downloading…",
    });
    return;
  }

  if (event.type === "processing") {
    const message = /merge/i.test(event.message)
      ? "Merging video and audio…"
      : /extract|ffmpeg/i.test(event.message)
        ? "Converting to MP3…"
        : "Finishing up…";
    emit(job, {
      status: "processing",
      percent: job.parts.length ? 100 : job.percent,
      speed: null,
      eta: null,
      message,
      filename: event.file || job.filename,
    });
    return;
  }

  if (event.type === "error") {
    job.error = event.message;
  }
}

async function run(job) {
  emit(job, { status: "downloading", percent: 0, message: "Contacting YouTube…" }, { force: true });

  let session;
  try {
    session = ytdlp.startDownload({
      url: job.url,
      mode: job.mode,
      quality: job.quality,
      dir: job.dir,
      onEvent: (event) => applyEvent(job, event),
    });
  } catch (err) {
    return failJob(job, err);
  }

  job.child = session.child;
  const result = await session.done;
  job.child = null;

  if (job.status === "canceled") return;

  if (result.error) {
    return failJob(
      job,
      result.error.code === "ENOENT"
        ? fail("yt-dlp is not installed on the server. Run `npm run setup`.", 503)
        : result.error
    );
  }

  if (result.code !== 0) {
    const detail = result.errors.length ? result.errors[result.errors.length - 1] : null;
    return failJob(job, fail(detail || `Download failed (yt-dlp exit code ${result.code}).`, 502));
  }

  const artifact = await ytdlp.pickArtifact(job.dir);
  if (!artifact) return failJob(job, fail("The download finished but produced no file.", 500));

  job.filePath = artifact.path;
  emit(
    job,
    {
      status: "done",
      percent: 100,
      sizeBytes: artifact.size,
      sizeText: ytdlp.humanBytes(artifact.size),
      filename: artifact.name,
      speed: null,
      eta: null,
      error: null,
      message: "Ready — starting your download…",
    },
    { force: true }
  );
}

function failJob(job, err) {
  emit(
    job,
    {
      status: "error",
      message: "Something went wrong",
      error: (err && err.message) || "Download failed.",
    },
    { force: true }
  );
}

/* ------------------------------------------------------------------ *
 * cancelling, delivering and cleanup
 * ------------------------------------------------------------------ */

async function cancel(id) {
  const job = jobs.get(id);
  if (!job) throw fail("That download is unknown or has expired.", 404);
  if (TERMINAL.has(job.status)) return publicJob(job);

  if (job.status === "queued") {
    const index = pending.indexOf(job);
    if (index >= 0) pending.splice(index, 1);
    emit(job, { status: "canceled", message: "Cancelled" }, { force: true });
    return publicJob(job);
  }

  const child = job.child;
  emit(job, { status: "canceled", message: "Cancelled" }, { force: true });
  if (isRunning(child)) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (isRunning(child)) child.kill("SIGKILL");
    }, 4000);
    if (typeof timer.unref === "function") timer.unref();
  }
  return publicJob(job);
}

/** Returns the finished file so it can be streamed to the browser. */
function deliverable(id) {
  const job = jobs.get(id);
  if (!job) throw fail("That download has expired. Please start it again.", 404);
  if (!job.filePath) {
    throw fail(
      job.status === "error"
        ? job.error || "That download failed."
        : "That download is not ready yet.",
      job.status === "error" ? 409 : 409
    );
  }
  if (!fs.existsSync(job.filePath)) {
    throw fail("That file is no longer on the server. Please start the download again.", 410);
  }
  return job;
}

function markDelivered(job) {
  job.deliveredAt = Date.now();
  if (job.status === "done") {
    emit(job, { status: "delivered", message: "Saved by your browser" }, { force: true });
  }
}

async function remove(job) {
  jobs.delete(job.id);
  const index = pending.indexOf(job);
  if (index >= 0) pending.splice(index, 1);
  endClients(job);
  await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

async function sweep() {
  const now = Date.now();
  for (const job of [...jobs.values()]) {
    const finished = TERMINAL.has(job.status);
    const ttl = finished ? JOB_TTL_MS : 2 * 60 * 60 * 1000; // stuck jobs after 2h
    if (now - job.updatedAt > ttl) await remove(job);
  }
}

function startSweeper() {
  const timer = setInterval(() => {
    sweep().catch(() => {});
  }, 60000);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

/** Kills running downloads (used on shutdown so no orphan yt-dlp is left). */
function shutdown() {
  for (const job of jobs.values()) {
    if (isRunning(job.child)) {
      try {
        job.child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = {
  MAX_CONCURRENT,
  addClient,
  cancel,
  create,
  deliverable,
  get,
  list,
  markDelivered,
  publicJob,
  remove,
  shutdown,
  snapshot,
  startSweeper,
  sweep,
};

