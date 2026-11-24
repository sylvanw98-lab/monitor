// 生成静态单文件页面 static/index.html：
// 内嵌模型快照历史 + 图片/视频价目数据，可部署到任意静态托管（GitHub Pages / Vercel / Netlify 等）
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(DIR, "static");

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
  let files = [];
  try {
    files = (await fs.readdir(path.join(DIR, "snapshots")))
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    files = [];
  }
  const snaps = [];
  for (const f of files) {
    try {
      snaps.push(JSON.parse(await fs.readFile(path.join(DIR, "snapshots", f), "utf8")));
    } catch {}
  }
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

async function readJsonSafe(p) {
  try {
    return { exists: true, ...JSON.parse(await fs.readFile(p, "utf8")) };
  } catch {
    return { exists: false };
  }
}

const html = await fs.readFile(path.join(DIR, "index.html"), "utf8");
const staticData = {
  generatedAt: new Date().toISOString(),
  data: await buildDataPayload(),
  prices: await readJsonSafe(path.join(DIR, "prices.json")),
  pricesVideo: await readJsonSafe(path.join(DIR, "prices-video.json")),
  oiioii: await readJsonSafe(path.join(DIR, "oiioii-prices.json")),
  krea: await readJsonSafe(path.join(DIR, "krea-prices.json")),
  kreaVideo: await readJsonSafe(path.join(DIR, "krea-video-prices.json")),
  liblibVideo: await readJsonSafe(path.join(DIR, "liblib-video-prices.json")),
};
const inject =
  "<script>window.__STATIC__=" + JSON.stringify(staticData) + ";</script>\n";
if (!html.includes("<script>")) throw new Error("index.html 缺少主 <script>");
const outHtml = html.replace("<script>", inject + "<script>");
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(OUT_DIR, "index.html"), outHtml);
console.log({
  built: path.join(OUT_DIR, "index.html"),
  snapshots: staticData.data.snapshotCount,
  currentAt: staticData.data.current ? staticData.data.current.scrapedAt : null,
  pricesExists: staticData.prices.exists,
  pricesVideoExists: staticData.pricesVideo.exists,
  oiioiiExists: staticData.oiioii.exists,
  kreaExists: staticData.krea.exists,
  kreaVideoExists: staticData.kreaVideo.exists,
  liblibVideoExists: staticData.liblibVideo.exists,
  sizeKB: Math.round(outHtml.length / 1024),
});
