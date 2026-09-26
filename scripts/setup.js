#!/usr/bin/env node
"use strict";

/**
 * Downloads the standalone yt-dlp binary into ./.tools so this app works
 * without root access, pip or a system package manager.
 *
 * Usage:
 *   npm run setup            # downloads only when missing
 *   node scripts/setup.js --force     # re-download (also updates yt-dlp)
 *   node scripts/setup.js --optional  # never fail (used by predev/prestart)
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFile } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BIN_DIR = path.join(ROOT, ".tools");
const IS_WIN = process.platform === "win32";
const TARGET = path.join(BIN_DIR, IS_WIN ? "yt-dlp.exe" : "yt-dlp");

// yt-dlp ships self-contained builds; pick the right one per platform/arch.
function assetName() {
  if (IS_WIN) return "yt-dlp.exe";
  if (process.platform === "darwin") return "yt-dlp_macos";
  if (process.platform === "linux" && process.arch === "arm64") return "yt-dlp_linux_aarch64";
  if (process.platform === "linux" && process.arch === "arm") return "yt-dlp_linux_armv7l";
  return "yt-dlp_linux";
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error("Too many redirects"));
    https
      .get(url, { headers: { "User-Agent": "mustafa-ytdl-setup/1.0" } }, (res) => {
        const { statusCode } = res;
        if ([301, 302, 303, 307, 308].includes(statusCode)) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(download(next, dest, redirects + 1));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode} while fetching ${url}`));
        }
        const total = Number(res.headers["content-length"] || 0);
        let seen = 0;
        let lastTick = 0;
        const out = fs.createWriteStream(dest);
        res.on("data", (chunk) => {
          seen += chunk.length;
          if (total && Date.now() - lastTick > 500) {
            lastTick = Date.now();
            const pct = ((seen / total) * 100).toFixed(0);
            process.stdout.write(
              `\r  downloading ${assetName()}  ${pct}%  (${(seen / 1048576).toFixed(1)} MiB)`
            );
          }
        });
        res.on("error", reject);
        out.on("error", reject);
        out.on("finish", () => {
          process.stdout.write("\n");
          out.close(() => resolve(dest));
        });
        res.pipe(out);
      })
      .on("error", reject);
  });
}

function version(bin) {
  return new Promise((resolve, reject) => {
    execFile(bin, ["--version"], { timeout: 30000 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout).trim())
    );
  });
}

async function main() {
  const force = process.argv.includes("--force");

  if (!force && fs.existsSync(TARGET)) {
    try {
      console.log(`✓ yt-dlp already present (${await version(TARGET)}) at ${TARGET}`);
      return;
    } catch {
      console.log("! existing binary is not runnable, re-downloading…");
    }
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tmp = `${TARGET}.download`;
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName()}`;

  console.log(`→ fetching ${url}`);
  await download(url, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, TARGET);

  console.log(`✓ installed yt-dlp ${await version(TARGET)} → ${TARGET}`);
  console.log("  (the file lives in .tools/ and is git-ignored)");
}

main().catch((err) => {
  console.error(`\n✗ setup failed: ${err.message}`);
  console.error("  Install yt-dlp manually and set YTDLP_PATH to its location.");
  // --optional (predev/prestart): keep the app bootable so the UI can explain
  // the problem instead of the server failing to start at all.
  process.exit(process.argv.includes("--optional") ? 0 : 1);
});
