// 模型监控全量采集：dreamina / krea / liblib / oiioii
// 每个平台采集图片+视频全部模型，合并为统一清单（每模型标注平台归属）
// 输出 models.json + snapshots/snapshot-<stamp>.json
import fs from "node:fs";

const BASE = "D:/ai project/ai需求开发/dreamina-monitor";
const PLATFORM_ORDER = ["dreamina", "krea", "liblib", "oiioii"];

// ============ 1) dreamina：模型配置接口（get_common_config，全量含 beta） ============
const DREAMINA_API = "https://dreamina-api-us-ttp2.us.capcut.com";
const DREAMINA_STARLING_NAME = { dre_recreate_model_name: "Dreamina Recreate" };
const DREAMINA_STARLING_TIP = {
  dre_recreate_model_desc: "Motion transfer, object swap, and creative remix, up to 30s",
};

async function collectDreamina() {
  const task = await taskSpace("dreamina-model-scraper");
  let pages = await task.pages();
  let page = pages.find((p) => p.label === "p1") || pages[0] || (await task.newPage());
  const wait = (ms) => page.waitForTimeout(ms);

  if (!String(await page.evaluate(() => location.href)).startsWith("https://dreamina.capcut.com")) {
    await page.goto("https://dreamina.capcut.com/ai-tool/home?type=image", { timeout: 60000 });
    await page.waitForLoadState();
    await wait(5000);
  }

  async function fetchModelConfig(label, url, body) {
    const res = await page.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Platform": "pc" },
      body: JSON.stringify(body),
      timeout: 30000,
    });
    const json = JSON.parse(res.body);
    if (json.ret !== "0") throw new Error(`${label} ret=${json.ret} ${json.errmsg}`);
    return json.data.model_list || [];
  }

  const out = { platform: "dreamina", image: [], video: [] };
  const q = "needCache=false&needRefresh=true";
  try {
    const list = await fetchModelConfig("图片", `${DREAMINA_API}/mweb/v1/get_common_config?${q}`, {
      isClientFilter: false,
      needBetaModel: true,
    });
    out.image = list.map((m) => ({ name: m.model_name || "", desc: m.model_tip || "" }));
    console.log(`[dreamina/image] ${out.image.length} 个模型`);
  } catch (err) {
    console.error(`[dreamina/image] 失败:`, String(err && err.message ? err.message : err).slice(0, 120));
  }
  try {
    const list = await fetchModelConfig(
      "视频",
      `${DREAMINA_API}/mweb/v1/video_generate/get_common_config?${q}`,
      { scene: "generate_video", params: { needCache: false } }
    );
    out.video = list
      .map((m) => ({
        name: m.model_name || DREAMINA_STARLING_NAME[m.model_name_starling_key] || "",
        desc: m.model_tip || DREAMINA_STARLING_TIP[m.model_tip_starling_key] || "",
      }))
      .filter((m) => m.name);
    console.log(`[dreamina/video] ${out.video.length} 个模型`);
  } catch (err) {
    console.error(`[dreamina/video] 失败:`, String(err && err.message ? err.message : err).slice(0, 120));
  }
  return out;
}

// ============ 2) krea：bundle 模型表（图片 BP5mBrn2 / 视频 BolESvrE，动态定位） ============
async function collectKrea() {
  const task = await taskSpace("krea-explore");
  let pages = await task.pages();
  const page = pages[0];
  const wait = (ms) => page.waitForTimeout(ms);

  async function findModelTable(needles) {
    return page.evaluate(async (needles) => {
      const chunks = performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .filter((n) => n.includes(location.origin) && /\/chunks\/.+\.js$/.test(n));
      for (const c of chunks) {
        try {
          const m = await import(c);
          for (const v of Object.values(m)) {
            if (!v || typeof v !== "object" || Array.isArray(v)) continue;
            const txt = JSON.stringify(v).slice(0, 4000000);
            if (needles.every((n) => txt.includes(n))) {
              const rows = [];
              for (const [key, e] of Object.entries(v)) {
                if (e && typeof e === "object" && e.name) {
                  const vis = e.visibilityRule?.visibility ?? (e.visibilityRule ? "flag" : "public");
                  // 与定价采集同口径：排除已下架(hidden)/内部(internal)模型
                  if (vis === "hidden" || vis === "internal") continue;
                  rows.push({
                    key,
                    name: e.name,
                    provider: e.provider || "",
                    visibility: vis,
                    desc: (e.description || "").slice(0, 80) + (vis !== "public" ? ` (${vis})` : ""),
                  });
                }
              }
              if (rows.length >= 10) return rows;
            }
          }
        } catch {}
      }
      return null;
    }, needles);
  }

  const out = { platform: "krea", image: [], video: [] };

  if (!String(await page.evaluate(() => location.href)).startsWith("https://www.krea.ai/image")) {
    await page.goto("https://www.krea.ai/image", { timeout: 60000 });
    await page.waitForLoadState();
    await wait(5000);
  }
  const imgRows = await findModelTable(["Krea 2 Large", "Nano Banana"]);
  out.image = (imgRows || []).map((r) => ({ name: r.name, desc: r.desc }));
  console.log(`[krea/image] ${out.image.length} 个模型`);

  if (!String(await page.evaluate(() => location.href)).startsWith("https://www.krea.ai/video")) {
    await page.goto("https://www.krea.ai/video", { timeout: 60000 });
    await page.waitForLoadState();
    await wait(5000);
  }
  const vidRows = await findModelTable(["Hailuo 2.3", "Veo 3.1"]);
  out.video = (vidRows || []).map((r) => ({ name: r.name, desc: r.desc }));
  console.log(`[krea/video] ${out.video.length} 个模型`);
  return out;
}

// ============ 3) liblib：tool_spec/list 接口注册表 ============
const LIBLIB_VIDEO_DISPLAY = {
  "kling-video-o1": "Kling O1",
  "kling-video-enhance-o1": "Kling O1 Enhance",
  "kling-video-o3": "Kling 3.0",
  "kling-v3-omni": "Kling 3.0 Omni",
  "kling-v3-turbo": "Kling 3.0 Turbo",
  "kling-v4": "Kling 4.0",
  "kling-v4-flash": "Kling 4.0 Flash",
  "kling-v2-6": "Kling 2.6",
  "kling-2.1": "Kling 2.1",
  "kling-v2-5-turbo-pro": "Kling 2.5",
  "kling-v3-motion-control": "Kling O3 Motion Control",
  "motion-3.1-rapid": "Video 3.1 Rapid",
  "motion-3.1-lite": "Video 3.1 Lite",
  "motion-3.1": "Video 3.1",
  "motion-3-prime": "Video 3 Prime",
  "motion-3-rapid": "Video 3 Rapid",
  "star-video2.5-draft": "Seedance 2.5 Draft",
  "star-video2.5": "Seedance 2.5",
  "star-video2.5-flash": "Seedance 2.5 Flash",
  "star-video2": "Seedance 2.0",
  "star-video2-fast": "Seedance 2.0 Fast",
  "star-video2-mini": "Seedance 2.0 Mini",
  "seedance2.0": "Seedance 2.0",
  "seedance-1.5-pro": "Seedance 1.5 Pro",
  "doubao-seedance-pro": "Seedance 1.0 Pro",
  "doubao-seedance-lite": "Seedance 1.0 Lite",
  "scene-2": "Scene 2",
  "scene-2-ultra": "Scene 2 Ultra",
  "wanxiang-v2-6": "Wan 2.6",
  "wanxiang-plus": "Wan 2.2",
  "wanxiang-preview": "Wan 2.5",
  "wanx2.7-video": "Wan 2.7",
  "wanx3.0": "Wan 3.0",
  "wanx3.0-prime": "Wan 3.0 Prime",
  "wanx-motion-control": "Wan Motion Transfer",
  "MiniMax-Hailuo-2.3": "Hailuo 2.3",
  "MiniMax-Hailuo-2.3-Fast": "Hailuo 2.3 Fast",
  "MiniMax-Hailuo-o2": "Hailuo 02",
  "MiniMax-Hailuo-H3": "MiniMax H3",
  "MiniMax-Hailuo-H3-Max": "MiniMax H3 Max",
  "minimax-h3-hs": "MiniMax H3 Highspeed",
  "gemini-omni-flash": "Gemini Omni Flash",
  "happy-horse-1": "Happy Horse 1.0",
  "happy-horse-1.1": "Happy Horse 1.1",
  "viduq2": "Vidu Q2",
  "viduq2-pro": "Vidu Q2 Pro",
  "viduq2-turbo": "Vidu Q2 Turbo",
  "viduq3-pro": "Vidu Q3 Pro",
  "vidu-q4": "Vidu Q4",
  "midjourney-video": "MJ Video",
  "pixverse-v5": "Pixverse V5",
  "pixverse-v5.5": "Pixverse V5.5",
  "omnihuman-1.5": "OmniHuman 1.5",
  "lib-cinema": "AutoTake",
  "director-video": "Director Video",
  "topaz-video-upscaler": "Topaz Video Upscaler",
  "topaz-starlight-2.6": "Topaz Starlight 2.6",
  "volcano-video-upscaler": "Video Upscaler",
  "volcano-subtitle-eraser": "Subtitle Eraser",
  "volcano-portrait-matting": "Video Portrait Matting",
};
const LIBLIB_IMAGE_DISPLAY = {
  "multiple-angles": "Multiple Angles",
  "topaz-image-upscaler": "Topaz Upscaler",
  "hd-upscaling": "HD Upscaling",
  "kling-multi-shot": "Kling Multi-shot",
  "nebula-ultra": "Nebula Ultra",
  "flux-1": "Flux.1",
  "image-editor": "Image Editor",
  "image-editor-pro": "Image Editor Pro",
  "nebula-2-flash": "Nebula V2 Flash",
  "nebula-2.1": "Nebula V2.1",
  "nebula-core": "Nebula",
  "qwen-edit": "Qwen Image Edit",
  "orbit-2-image": "Orbit 2 Image",
  "lib-image-2": "Lib Image",
  "lib-image-2.5-s": "Lib Image 2.5 S",
  "lib-image-2.5-f": "Lib Image 2.5 F",
  "lib-image-2.6-a": "Lib Image 2.6 A",
  "lib-image-2.6-s": "Lib Image 2.6 S",
  "director-image": "Director Image",
  "jimeng-4.6": "Seedream 4.6",
  "seedream-4": "Seedream 4.0",
  "seedream-4.5": "Seedream 4.5",
  "seedream-5": "Seedream 5.0",
  "doubao-seedream-5-0-pro": "Seedream 5.0 Pro",
  "doubao-seedream-5-5": "Seedream 5.5",
  "minimax-h3-image": "MiniMax H3 Image",
  "minimax-h3-image-hs": "MiniMax H3 Image HS",
  "mj-v7": "Midjourney V7",
  "mj-v8.1": "Midjourney V8.1",
  "mj-v8.2": "Midjourney V8.2",
  "mj-niji7": "Midjourney Niji 7",
  "qwen": "Qwen Image",
  "qwen-image-3": "Qwen Image 3",
  "z-image": "Z-Image",
  "seedream-5.0-pro-layer": "Seedream 5.0 Pro Layer",
  "seedream-5.5-layer": "Seedream 5.5 Layer",
  "topaz-wonder-4": "Topaz Wonder 4",
  "lib-prism": "Lib-prism",
};

async function collectLiblib() {
  const task = await taskSpace("liblib-explore");
  let pages = await task.pages();
  const page = pages[0];
  const wait = (ms) => page.waitForTimeout(ms);

  if (!String(await page.evaluate(() => location.href)).includes("liblib.tv")) {
    await page.goto("https://www.liblib.tv/canvas", { timeout: 60000 });
    await page.waitForLoadState();
    await wait(5000);
  }
  const auth = await page.evaluate(() => {
    const out = {};
    document.cookie.split(";").forEach((c) => { const [k, v] = c.trim().split("="); out[k] = v; });
    return { usertoken: out.usertoken, webid: out.webid };
  });
  const specRes = await page.fetch("https://api.liblib.tv/api/tool_spec/list", { timeout: 30000 });
  const spec = JSON.parse(specRes.body);
  if (spec.code !== 0) throw new Error("tool_spec/list code " + spec.code + " " + spec.msg);

  const out = { platform: "liblib", image: [], video: [] };
  // 与定价采集同口径：排除非生成工具（增强/超分/擦除/抠图/动作控制；图片侧另排除编辑/多视角/多镜头）
  const EXCLUDE = /enhance|upscal|eraser|matting|starlight|motion-control|edit|angles|multi-shot/;
  for (const t of spec.data.tools) {
    let meta = {};
    try { meta = JSON.parse(t.metadata); } catch {}
    const modelKey = meta.modelKey || t.toolKey;
    const orig = meta.modelName || "";
    if (EXCLUDE.test(t.toolKey)) continue;
    let name;
    if (t.type === "video") {
      name = LIBLIB_VIDEO_DISPLAY[modelKey] || orig || modelKey;
    } else if (t.type === "image") {
      name = LIBLIB_IMAGE_DISPLAY[modelKey] || orig || modelKey;
    } else {
      continue;
    }
    const rec = { name };
    if (/[一-鿿]/.test(orig) && orig !== name) rec.desc = orig;
    out[t.type].push(rec);
  }
  console.log(`[liblib/image] ${out.image.length} 个 | [liblib/video] ${out.video.length} 个`);
  return out;
}

// ============ 4) oiioii：UI 模型下拉 ============
const OII_NAME_MAP = {
  "Oii Image 2.6 Fast": "GPT Image 2.6 Flare",
  "Oii Image 2.6 Pro": "GPT Image 2.6 Sunburst",
  "Oii Image 2.5 Fast": "GPT Image 2.5 Flare",
  "Oii Image 2.5 Pro": "GPT Image 2.5 Sunburst",
  "Oii Image 2": "GPT Image 2",
  "Oii N Pro": "Nano Banana Pro",
  "Oii N 2.1": "Nano Banana 2.1",
  "Oii N 2": "Nano Banana 2",
  "Oii Style v8.2": "Midjourney v8.2",
  "Oii Style v8.1": "Midjourney v8.1",
  "Oii Style niji7": "Niji 7",
  "Oii Style niji6": "Niji 6",
};

async function collectOiioii() {
  const URL = "https://www.oiioii.ai/space/490e95a3-0056-4f9f-a5a0-c4e63b5d7bb8";
  const task = await taskSpace("dreamina-page-verify");
  let pages = await task.pages();
  let page = pages[0] || (await task.newPage());
  const wait = (ms) => page.waitForTimeout(ms);

  await page.goto(URL, { timeout: 60000 });
  await page.waitForLoadState();
  await wait(10000);

  for (let i = 0; i < 4; i++) {
    const ready = await page.evaluate(() => {
      const b = document.querySelector("._select-btn_as85o_117");
      return !!b && (b.offsetParent !== null || b.getClientRects().length > 0);
    });
    if (ready) break;
    const nodeBox = await page.evaluate(() => {
      const n = document.querySelector(".react-flow__node-canvas-node");
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (nodeBox) await page.mouse.click(nodeBox.x, nodeBox.y);
    await wait(3000);
  }

  const collectNames = () => page.evaluate(() => {
    return [...document.querySelectorAll("._model-name_6ksin_323")]
      .filter((e) => e.offsetParent !== null || e.getClientRects().length > 0)
      .map((e) => {
        const span = e.querySelector("span");
        let name = span ? span.textContent.trim() : e.textContent.trim();
        name = name.replace(/\s*(New|Best|Limited Time:\s*[\d%]+\s*OFF)\s*$/i, "").trim();
        return name;
      })
      .filter(Boolean);
  });

  for (let i = 0; i < 3; i++) {
    const names = await collectNames();
    if (names.length > 0) break;
    await page.evaluate(() => {
      [...document.querySelectorAll("._select-btn_as85o_117")].forEach((b) => b.click());
    });
    await wait(1800);
  }
  const names = await collectNames();
  const out = {
    platform: "oiioii",
    image: names.map((n) => ({ name: OII_NAME_MAP[n] || n, desc: "" })),
    video: [],
  };
  console.log(`[oiioii/image] ${out.image.length} 个模型`);
  return out;
}

// ============ 合并：统一清单 + 平台归属 ============
const ALIAS = {
  "seedream5.0 pro": "Seedream 5.0 Pro",
  "seedream 5 pro": "Seedream 5.0 Pro",
  "seedream 4": "Seedream 4.0",
  "chatgpt 2": "GPT Image 2",
  "chatgpt 1.5": "GPT Image 1.5",
  "chatgpt image": "GPT Image",
  "z-image": "Z-Image",
  "z image": "Z-Image",
  "qwen image3": "Qwen Image 3",
  "qwen image 2512": "Qwen Image Max",
  "midjourney niji 7": "Niji 7",
  "nano banana flash": "Nano Banana 2",
  "flux 2 klein": "Flux 2 Mini",
  "genesis f.3": "Flux 3 Image",
  "flux 1": "Flux.1",
  "flux.1 krea": "Flux.1 Krea",
  "orbit 2 image": "Orbit 2 Image",
  "happyhorse": "Happy Horse 1.0",
  "kling o1": "Kling O1",
};

function canonical(name) {
  const t = String(name || "").trim();
  const display0 = t.replace(/^Dreamina\s+/i, "");
  const rawKey = display0.replace(/\s+/g, " ").toLowerCase();
  const display = ALIAS[rawKey] || display0;
  // key 必须从映射后的显示名计算，否则"原始名不同但显示名相同"的模型会分成两条
  return { key: display.replace(/\s+/g, " ").toLowerCase(), display };
}

function merge(platformData) {
  const unified = { image: [], video: [] };
  for (const pd of platformData) {
    for (const type of ["image", "video"]) {
      for (const m of pd[type] || []) {
        const { key, display } = canonical(m.name);
        let u = unified[type].find((x) => x.key === key);
        if (!u) {
          u = { key, name: display, platforms: [], desc: "" };
          unified[type].push(u);
        }
        if (!u.platforms.includes(pd.platform)) u.platforms.push(pd.platform);
        if (!u.desc && m.desc) u.desc = m.desc;
      }
    }
  }
  for (const type of ["image", "video"]) {
    unified[type].sort((a, b) => a.name.localeCompare(b.name, "en"));
    unified[type].forEach((u) => {
      delete u.key;
      u.platforms.sort((a, b) => PLATFORM_ORDER.indexOf(a) - PLATFORM_ORDER.indexOf(b));
    });
  }
  return unified;
}

// ============ 主流程 ============
const platformData = [];
const jobs = [
  { name: "dreamina", fn: collectDreamina },
  { name: "krea", fn: collectKrea },
  { name: "liblib", fn: collectLiblib },
  { name: "oiioii", fn: collectOiioii },
];
for (const j of jobs) {
  try {
    const data = await j.fn();
    platformData.push(data);
  } catch (err) {
    console.error(`[${j.name}] 采集失败:`, String(err && err.message ? err.message : err).slice(0, 150));
    platformData.push({ platform: j.name, image: [], video: [], error: String(err && err.message ? err.message : err).slice(0, 200) });
  }
}

const okCount = platformData.filter((p) => (p.image || []).length + (p.video || []).length > 0).length;
if (okCount === 0) throw new Error("所有平台采集失败");

const unified = merge(platformData);
const result = {
  scrapedAt: new Date().toISOString(),
  sources: platformData.map((pd) => ({
    platform: pd.platform,
    image: (pd.image || []).map((m) => ({ name: m.name, desc: m.desc || "" })),
    video: (pd.video || []).map((m) => ({ name: m.name, desc: m.desc || "" })),
  })),
  unified,
};

fs.writeFileSync(`${BASE}/models.json`, JSON.stringify(result, null, 2));
const stamp = result.scrapedAt.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
fs.writeFileSync(`${BASE}/snapshots/snapshot-${stamp}.json`, JSON.stringify(result, null, 2));
console.log("== 完成 ==");
for (const pd of result.sources) {
  console.log(`  ${pd.platform}: 图片 ${pd.image.length} | 视频 ${pd.video.length}`);
}
console.log(`  统一清单: 图片 ${unified.image.length} | 视频 ${unified.video.length}`);
console.log("  多平台模型数:", unified.image.filter((u) => u.platforms.length > 1).length + unified.video.filter((u) => u.platforms.length > 1).length);
console.log("DONE");
