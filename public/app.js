"use strict";

/* Small vanilla-JS front-end for the YouTube downloader API. */

const $ = (id) => document.getElementById(id);

const els = {
  statusPill: $("statusPill"),
  form: $("fetchForm"),
  url: $("urlInput"),
  fetchBtn: $("fetchBtn"),
  errorBox: $("errorBox"),
  setupBox: $("setupBox"),
  infoSection: $("infoSection"),
  thumb: $("thumb"),
  title: $("vTitle"),
  uploader: $("vUploader"),
  meta: $("vMeta"),
  tabVideo: $("tabVideo"),
  tabAudio: $("tabAudio"),
  quality: $("qualitySelect"),
  downloadBtn: $("downloadBtn"),
  progressSection: $("progressSection"),
  progressMessage: $("progressMessage"),
  progressPercent: $("progressPercent"),
  progressDetail: $("progressDetail"),
  progressBar: $("progressBar"),
  cancelBtn: $("cancelBtn"),
  successBox: $("successBox"),
  savedName: $("savedName"),
  saveAgain: $("saveAgain"),
  serverInfo: $("serverInfo"),
};

const VIDEO_LABELS = {
  best: "Best available",
  1080: "1080p · Full HD",
  720: "720p · HD",
  480: "480p",
  360: "360p",
};

const AUDIO_LABELS = {
  320: "320 kbps · best",
  256: "256 kbps",
  192: "192 kbps",
  128: "128 kbps",
};

const state = {
  info: null,
  mode: "video",
  quality: "best",
  job: null,
  savedFor: null,
  source: null,
  pollTimer: null,
  fallbackTimer: null,
  ready: false,
};

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return null;
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatViews(views) {
  if (!views) return null;
  if (views >= 1e9) return `${(views / 1e9).toFixed(1)}B views`;
  if (views >= 1e6) return `${(views / 1e6).toFixed(1)}M views`;
  if (views >= 1e3) return `${(views / 1e3).toFixed(1)}K views`;
  return `${views} views`;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error((payload && payload.error) || `Request failed (${response.status})`);
  }
  return payload;
}

function post(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.hidden = false;
}

function clearMessages() {
  els.errorBox.hidden = true;
  els.errorBox.textContent = "";
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (label) button.textContent = label;
}

/* ------------------------------------------------------------------ *
 * health
 * ------------------------------------------------------------------ */

async function checkHealth() {
  try {
    const info = await api("/api/health");
    state.ready = Boolean(info.installed);
    if (state.ready) {
      els.statusPill.className = "pill ok";
      els.statusPill.textContent = `yt-dlp ${info.version}`;
      els.serverInfo.textContent = `yt-dlp ${info.version} · ffmpeg ${
        info.ffmpeg ? "available" : "missing"
      }${info.cookies ? " · cookies loaded" : ""}`;
      els.setupBox.hidden = true;
    } else {
      els.statusPill.className = "pill bad";
      els.statusPill.textContent = "yt-dlp missing";
      els.setupBox.innerHTML = `⚠ The server has no <code>yt-dlp</code> yet. Run
        <code>npm run setup</code> in the project folder and reload this page.
        <br /><small>${info.error || ""}</small>`;
      els.setupBox.hidden = false;
    }
  } catch (err) {
    els.statusPill.className = "pill bad";
    els.statusPill.textContent = "server unreachable";
    showError(err.message);
  } finally {
    els.downloadBtn.disabled = !state.ready;
  }
}

/* ------------------------------------------------------------------ *
 * video info
 * ------------------------------------------------------------------ */

function renderInfo(info) {
  if (info.thumbnail) {
    els.thumb.src = info.thumbnail.startsWith("//") ? `https:${info.thumbnail}` : info.thumbnail;
    els.thumb.hidden = false;
  } else {
    els.thumb.hidden = true;
  }

  els.title.textContent = info.title;
  els.uploader.textContent = info.uploader ? `by ${info.uploader}` : "";

  const parts = [];
  if (info.durationText) parts.push(`⏱ ${info.durationText}`);
  if (info.maxHeight) parts.push(`📺 up to ${info.maxHeight}p`);
  const views = formatViews(info.viewCount);
  if (views) parts.push(`👁 ${views}`);
  if (info.isLive) parts.push("🔴 live");
  els.meta.textContent = parts.join("  ·  ");
}

function renderQualities() {
  const info = state.info;
  els.quality.innerHTML = "";

  const options =
    state.mode === "audio"
      ? Object.keys(AUDIO_LABELS).map((kbps) => ({
          value: kbps,
          label: AUDIO_LABELS[kbps],
          size: info && info.audioSizes ? info.audioSizes[kbps] : null,
        }))
      : (info ? info.qualities : ["best"]).map((quality) => ({
          value: String(quality),
          label: VIDEO_LABELS[quality] || `${quality}p`,
          size: info && info.sizes ? info.sizes[quality] : null,
        }));

  for (const option of options) {
    const element = document.createElement("option");
    element.value = option.value;
    const size = formatBytes(option.size);
    element.textContent = size ? `${option.label} — ≈ ${size}` : option.label;
    els.quality.appendChild(element);
  }

  const values = options.map((option) => option.value);
  const preferred = state.mode === "audio" ? "192" : "best";
  if (!values.includes(state.quality)) state.quality = preferred;
  if (!values.includes(state.quality)) state.quality = values[0];
  els.quality.value = state.quality;
}

function setMode(mode) {
  state.mode = mode;
  els.tabVideo.classList.toggle("active", mode === "video");
  els.tabAudio.classList.toggle("active", mode === "audio");
  renderQualities();
}

/* ------------------------------------------------------------------ *
 * download flow
 * ------------------------------------------------------------------ */

function isFinished(job) {
  return Boolean(job) && ["done", "delivered", "error", "canceled"].includes(job.status);
}

function stopWatching() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.fallbackTimer) {
    clearTimeout(state.fallbackTimer);
    state.fallbackTimer = null;
  }
}

function showProgress(job) {
  els.progressSection.hidden = false;

  const queued = job.status === "queued";
  els.progressMessage.textContent =
    queued && job.queuePosition > 1
      ? `Waiting in queue — position ${job.queuePosition}`
      : job.message || "Working…";

  const percent = Math.max(0, Math.min(100, Number(job.percent) || 0));
  els.progressPercent.textContent = `${Math.round(percent)}%`;

  const detail = [];
  if (job.sizeText) detail.push(job.sizeText);
  if (job.speed) detail.push(job.speed);
  if (job.eta) detail.push(`ETA ${job.eta}`);
  els.progressDetail.textContent = detail.length ? ` · ${detail.join(" · ")}` : "";

  els.progressBar.classList.toggle("indeterminate", queued || job.status === "processing");
  els.progressBar.firstElementChild.style.width = `${Math.max(2, percent)}%`;
  els.cancelBtn.disabled = isFinished(job);
}

function triggerSave(job) {
  const link = document.createElement("a");
  link.href = `/api/file/${job.id}`;
  link.download = job.filename || "";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => link.remove(), 2000);
}

function handleUpdate(job) {
  state.job = job;
  showProgress(job);

  if (job.status === "done") {
    if (state.savedFor !== job.id) {
      state.savedFor = job.id;
      els.savedName.textContent = job.filename || "your file";
      els.saveAgain.href = `/api/file/${job.id}`;
      els.saveAgain.setAttribute("download", job.filename || "");
      els.successBox.hidden = false;
      triggerSave(job);
    }
    stopWatching();
    return;
  }

  if (job.status === "delivered" || job.status === "canceled" || job.status === "error") {
    stopWatching();
    if (job.status === "error") showError(job.error || "The download failed.");
    if (job.status === "delivered") {
      els.progressMessage.textContent = "Saved by your browser";
    }
  }
}

function startPolling(id) {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    try {
      handleUpdate(await api(`/api/status/${id}`));
    } catch (err) {
      stopWatching();
      showError(err.message);
    }
  }, 900);
}

function subscribe(id) {
  stopWatching();

  let received = false;
  const source = new EventSource(`/api/progress/${id}`);
  state.source = source;

  // If nginx buffers the event stream we fall back to plain polling.
  state.fallbackTimer = setTimeout(() => {
    if (received) return;
    source.close();
    state.source = null;
    startPolling(id);
  }, 3000);

  source.onmessage = (event) => {
    received = true;
    clearTimeout(state.fallbackTimer);
    state.fallbackTimer = null;
    try {
      handleUpdate(JSON.parse(event.data));
    } catch {
      /* ignore malformed frame */
    }
  };

  source.onerror = () => {
    source.close();
    state.source = null;
    if (!isFinished(state.job)) startPolling(id);
  };
}

async function startDownload() {
  if (!state.info) return;
  clearMessages();
  els.successBox.hidden = true;
  state.savedFor = null;

  setBusy(els.downloadBtn, true, "Starting…");
  try {
    const job = await post("/api/download", {
      url: state.info.webpageUrl,
      mode: state.mode,
      quality: state.quality,
      info: {
        title: state.info.title,
        uploader: state.info.uploader,
        thumbnail: state.info.thumbnail,
      },
    });
    state.job = job;
    showProgress(job);
    subscribe(job.id);
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(els.downloadBtn, false, "Download");
  }
}

/* ------------------------------------------------------------------ *
 * wiring
 * ------------------------------------------------------------------ */

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = els.url.value.trim();
  if (!url) return;

  clearMessages();
  els.successBox.hidden = true;
  els.infoSection.hidden = true;
  els.progressSection.hidden = true;
  stopWatching();

  setBusy(els.fetchBtn, true, "Checking…");
  try {
    const info = await post("/api/info", { url });
    state.info = info;
    state.quality = state.mode === "audio" ? "192" : "best";
    renderInfo(info);
    renderQualities();
    els.infoSection.hidden = false;
  } catch (err) {
    state.info = null;
    showError(err.message);
  } finally {
    setBusy(els.fetchBtn, false, "Check link");
  }
});

els.tabVideo.addEventListener("click", () => setMode("video"));
els.tabAudio.addEventListener("click", () => setMode("audio"));

els.quality.addEventListener("change", () => {
  state.quality = els.quality.value;
});

els.downloadBtn.addEventListener("click", startDownload);

els.cancelBtn.addEventListener("click", async () => {
  const id = state.job && state.job.id;
  if (!id) return;
  els.cancelBtn.disabled = true;
  try {
    handleUpdate(await post(`/api/cancel/${id}`));
  } catch (err) {
    showError(err.message);
  }
});

els.url.addEventListener("input", () => {
  els.infoSection.hidden = true;
  state.info = null;
});

window.addEventListener("beforeunload", stopWatching);

const preset = new URLSearchParams(window.location.search).get("url");
if (preset) els.url.value = preset;

renderQualities();
checkHealth();
els.url.focus();


