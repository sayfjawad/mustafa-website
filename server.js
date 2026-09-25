// Zero-dependency static file server for the workshop starter.
// Serves this directory on 0.0.0.0:3000 so the app shows up at
// https://mustafa.sdai.nl once the container is running.
// Replace this with your own app (React, Vite, Express, ...) — just keep
// binding to 0.0.0.0:3000 so nginx can reach it.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

http
  .createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0]);
    if (rel === "/") rel = "/index.html";
    const file = path.join(ROOT, path.normalize(rel));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        return res.end("<h1>404 — Not Found</h1>");
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      });
      res.end(data);
    });
  })
  .listen(PORT, "0.0.0.0", () =>
    console.log(`mustafa-website serving ${ROOT} on http://0.0.0.0:${PORT}`)
  );
