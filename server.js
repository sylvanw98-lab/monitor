const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const DIR = __dirname;
const SCRAPE_PATH = path.join(DIR, "scrape-models-all.mjs");
const SCRAPE_PRICES_PATH = path.join(DIR, "scrape-prices.mjs");
const PRICES_PATH = path.join(DIR, "prices.json");
const SCRAPE_VIDEO_PRICES_PATH = path.join(DIR, "scrape-video-prices.mjs");
const PRICES_VIDEO_PATH = path.join(DIR, "prices-video.json");
const SCRAPE_OIIOII_PRICES_PATH = path.join(DIR, "scrape-oiioii-prices.mjs");
const OIIOII_PRICES_PATH = path.join(DIR, "oiioii-prices.json");
const SCRAPE_KREA_PRICES_PATH = path.join(DIR, "scrape-krea-prices.mjs");
const KREA_PRICES_PATH = path.join(DIR, "krea-prices.json");
const SCRAPE_KREA_VIDEO_PRICES_PATH = path.join(DIR, "scrape-krea-video-prices.mjs");
const KREA_VIDEO_PRICES_PATH = path.join(DIR, "krea-video-prices.json");
const SCRAPE_LIBLIB_VIDEO_PRICES_PATH = path.join(DIR, "scrape-liblib-video-prices.mjs");
const LIBLIB_VIDEO_PRICES_PATH = path.join(DIR, "liblib-video-prices.json");
const SNAPSHOT_DIR = path.join(DIR, "snapshots");
const PORT = Number(process.env.PORT) || 8527;

let refreshing = false;
let pricesRefreshing = false;
let pricesVideoRefreshing = false;
let oiioiiRefreshing = false;
let kreaRefreshing = false;
let kreaVideoRefreshing = false;
let liblibVideoRefreshing = false;

function resolveEgoBinary() {
  const candidates = [
    process.env.EGO_BROWSER,
    path.join(
      os.homedir(),
      ".local/share/ego/active_version_dir/ego-browser.exe"
    ),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function readSnapshots() {
  let files = [];
  try {
    files = (await fsp.readdir(SNAPSHOT_DIR))
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(SNAPSHOT_DIR, f), "utf8")));
    } catch {
      // skip unreadable snapshot
    }
  }
  return out;
}

function modelKey(type, name) {
  return `${type}::${name}`;
}

function flattenModels(snapshot) {
  const keys = new Set();
  const unified = snapshot.unified || {};
  for (const type of ["image", "video"]) {
    for (const m of unified[type] || []) {
      if (m.name) keys.add(modelKey(type, m.name));
    }
  }
  return keys;
}

function parseKey(key) {
  const i = key.indexOf("::");
  return { type: key.slice(0, i), name: key.slice(i + 2) };
}

async function buildDataPayload() {
  const snaps = await readSnapshots();
  const current = snaps[snaps.length - 1] || null;
  const previous = snaps[snaps.length - 2] || null;
  const baseline = current && !previous;
  const diff = { added: [], removed: [] };
  if (current && previous) {
    const curKeys = flattenModels(current);
    const prevKeys = flattenModels(previous);
    const curUnified = current.unified || {};
    for (const k of curKeys) {
      if (!prevKeys.has(k)) {
        const { type, name } = parseKey(k);
        const u = (curUnified[type] || []).find((x) => x.name === name);
        diff.added.push({ type, name, platforms: u ? u.platforms : [] });
      }
    }
    for (const k of prevKeys) {
      if (!curKeys.has(k)) diff.removed.push(parseKey(k));
    }
  }
  return {
    current,
    previousAt: previous ? previous.scrapedAt : null,
    baseline,
    diff,
    snapshotCount: snaps.length,
  };
}

function runEgoScript(scriptPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const fileUrl =
      "file:///" + encodeURI(scriptPath.replace(/\\/g, "/"));
    const args = ["nodejs", "-e", `await import('${fileUrl}')`];
    const exe = resolveEgoBinary();
    const child = exe
      ? spawn(exe, args, {
          cwd: DIR,
          windowsHide: true,
        })
      : spawn("ego-browser", args, {
          cwd: DIR,
          shell: true,
          windowsHide: true,
        });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`scrape timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `scrape exited with code ${code}: ${(stderr || stdout).slice(-800)}`
          )
        );
      }
    });
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = await fsp.readFile(path.join(DIR, "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/data") {
      sendJson(res, 200, await buildDataPayload());
      return;
    }
    if (req.method === "GET" && url.pathname === "/prices") {
      try {
        const data = JSON.parse(await fsp.readFile(PRICES_PATH, "utf8"));
        sendJson(res, 200, { exists: true, ...data });
      } catch {
        sendJson(res, 200, { exists: false });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/prices-video") {
      try {
        const data = JSON.parse(await fsp.readFile(PRICES_VIDEO_PATH, "utf8"));
        sendJson(res, 200, { exists: true, ...data });
      } catch {
        sendJson(res, 200, { exists: false });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/prices-oiioii") {
      try {
        const data = JSON.parse(await fsp.readFile(OIIOII_PRICES_PATH, "utf8"));
        sendJson(res, 200, { exists: true, ...data });
      } catch {
        sendJson(res, 200, { exists: false });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/prices-krea") {
      try {
        const data = JSON.parse(await fsp.readFile(KREA_PRICES_PATH, "utf8"));
        sendJson(res, 200, { exists: true, ...data });
      } catch {
        sendJson(res, 200, { exists: false });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/prices-krea-video") {
      try {
        const data = JSON.parse(await fsp.readFile(KREA_VIDEO_PRICES_PATH, "utf8"));
        sendJson(res, 200, { exists: true, ...data });
      } catch {
        sendJson(res, 200, { exists: false });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/refresh") {
      if (refreshing) {
        sendJson(res, 409, { error: "刷新正在进行中，请稍候" });
        return;
      }
      refreshing = true;
      console.log("[refresh] scraping started");
      try {
        await runEgoScript(SCRAPE_PATH, 600000);
        console.log("[refresh] scraping done");
        sendJson(res, 200, await buildDataPayload());
      } catch (err) {
        console.error("[refresh] failed:", err.message);
        sendJson(res, 500, { error: String(err.message) });
      } finally {
        refreshing = false;
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/refresh-prices") {
      if (pricesRefreshing) {
        sendJson(res, 409, { error: "积分抓取正在进行中，请稍候" });
        return;
      }
      pricesRefreshing = true;
      console.log("[refresh-prices] scraping started");
      try {
        await runEgoScript(SCRAPE_PRICES_PATH, 600000);
        console.log("[refresh-prices] scraping done");
        const data = JSON.parse(await fsp.readFile(PRICES_PATH, "utf8"));
        sendJson(res, 200, { exists: true, ...data });
      } catch (err) {
        console.error("[refresh-prices] failed:", err.message);
        sendJson(res, 500, { error: String(err.message) });
      } finally {
        pricesRefreshing = false;
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/refresh-prices-video") {
      if (pricesVideoRefreshing) {
        sendJson(res, 409, { error: "视频积分抓取正在进行中，请稍候" });
        return;
      }
      pricesVideoRefreshing = true;
      console.log("[refresh-prices-video] scraping started");
      try {
        await runEgoScript(SCRAPE_VIDEO_PRICES_PATH, 600000);
        console.log("[refresh-prices-video] scraping done");
        const data = JSON.parse(await fsp.readFile(PRICES_VIDEO_PATH, "utf8"));
        sendJson(res, 200, { exists: true, ...data });
      } catch (err) {
        console.error("[refresh-prices-video] failed:", err.message);
        sendJson(res, 500, { error: String(err.message) });
      } finally {
        pricesVideoRefreshing = false;
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/refresh-prices-oiioii") {
      if (oiioiiRefreshing) {
        sendJson(res, 409, { error: "oiioii 积分抓取正在进行中，请稍候" });
        return;
      }
      oiioiiRefreshing = true;
      console.log("[refresh-prices-oiioii] scraping started");
      try {
        await runEgoScript(SCRAPE_OIIOII_PRICES_PATH, 600000);
        console.log("[refresh-prices-oiioii] scraping done");
        const data = JSON.parse(await fsp.readFile(OIIOII_PRICES_PATH, "utf8"));
        sendJson(res, 200, { exists: true, ...data });
      } catch (err) {
        console.error("[refresh-prices-oiioii] failed:", err.message);
        sendJson(res, 500, { error: String(err.message) });
      } finally {
        oiioiiRefreshing = false;
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/refresh-prices-krea") {
      if (kreaRefreshing) {
        sendJson(res, 409, { error: "krea 积分抓取正在进行中，请稍候" });
        return;
      }
      kreaRefreshing = true;
      console.log("[refresh-prices-krea] scraping started");
      try {
        await runEgoScript(SCRAPE_KREA_PRICES_PATH, 600000);
        console.log("[refresh-prices-krea] scraping done");
        const data = JSON.parse(await fsp.readFile(KREA_PRICES_PATH, "utf8"));
        sendJson(res, 200, { exists: true, ...data });
      } catch (err) {
        console.error("[refresh-prices-krea] failed:", err.message);
        sendJson(res, 500, { error: String(err.message) });
      } finally {
        kreaRefreshing = false;
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/prices-liblib-video") {
      try {
        const data = JSON.parse(await fsp.readFile(LIBLIB_VIDEO_PRICES_PATH, "utf8"));
        sendJson(res, 200, { exists: true, ...data });
      } catch {
        sendJson(res, 200, { exists: false });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/refresh-prices-liblib-video") {
      if (liblibVideoRefreshing) {
        sendJson(res, 409, { error: "liblib 视频积分抓取正在进行中，请稍候" });
        return;
      }
      liblibVideoRefreshing = true;
      console.log("[refresh-prices-liblib-video] scraping started");
      try {
        await runEgoScript(SCRAPE_LIBLIB_VIDEO_PRICES_PATH, 600000);
        console.log("[refresh-prices-liblib-video] scraping done");
        const data = JSON.parse(await fsp.readFile(LIBLIB_VIDEO_PRICES_PATH, "utf8"));
        sendJson(res, 200, { exists: true, ...data });
      } catch (err) {
        console.error("[refresh-prices-liblib-video] failed:", err.message);
        sendJson(res, 500, { error: String(err.message) });
      } finally {
        liblibVideoRefreshing = false;
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/refresh-prices-krea-video") {
      if (kreaVideoRefreshing) {
        sendJson(res, 409, { error: "krea 视频积分抓取正在进行中，请稍候" });
        return;
      }
      kreaVideoRefreshing = true;
      console.log("[refresh-prices-krea-video] scraping started");
      try {
        await runEgoScript(SCRAPE_KREA_VIDEO_PRICES_PATH, 600000);
        console.log("[refresh-prices-krea-video] scraping done");
        const data = JSON.parse(await fsp.readFile(KREA_VIDEO_PRICES_PATH, "utf8"));
        sendJson(res, 200, { exists: true, ...data });
      } catch (err) {
        console.error("[refresh-prices-krea-video] failed:", err.message);
        sendJson(res, 500, { error: String(err.message) });
      } finally {
        kreaVideoRefreshing = false;
      }
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: String(err.message) });
  }
});

server.listen(PORT, () => {
  console.log(`Dreamina 模型监控已启动: http://localhost:${PORT}`);
});
