// 采集 liblib.tv 视频生成积分价目（纯接口方式：tool_spec/list 模型注册表 + power/calculator 直查）
// 覆盖：模型 × 模式 × 分辨率 × 质量 × 时长（全部枚举档位，比例固定 16:9 不影响价格）
import fs from "node:fs";
import path from "node:path";

const OUT = path.join("D:/ai project/ai需求开发/dreamina-monitor", "liblib-video-prices.json");
const RAW = path.join("D:/ai project/ai需求开发/dreamina-monitor", "tmp-liblib-js", "liblib-raw-probes.json");

const task = await taskSpace("liblib-explore");
let pages = await task.pages();
let page = pages[0];
const wait = (ms) => page.waitForTimeout(ms);

// 1) 确保登录态 + 打开画布页（保证 cookie 齐全）
await page.goto("https://www.liblib.tv/canvas?guideSource=home-feature-grid&spaceId=16058054&projectId=b5673904ab2d4c8f9a2e3200f6ad6296", { timeout: 60000 });
await page.waitForLoadState();
await wait(6000);

const auth = await page.evaluate(() => {
  const out = {};
  document.cookie.split(";").forEach((c) => {
    const [k, v] = c.trim().split("=");
    out[k] = v;
  });
  return { usertoken: out.usertoken, webid: out.webid };
});
if (!auth.usertoken) {
  console.log("FATAL: 未登录（无 usertoken cookie）");
  await task.finish();
  process.exit(1);
}

// 2) 模型注册表
const specRes = await page.fetch("https://api.liblib.tv/api/tool_spec/list", { timeout: 30000 });
const spec = JSON.parse(specRes.body);
if (spec.code !== 0) {
  console.log("FATAL: tool_spec/list code", spec.code, spec.msg);
  await task.finish();
  process.exit(1);
}
const videoTools = spec.data.tools.filter((t) => t.type === "video").map((t) => {
  let meta = {};
  try { meta = JSON.parse(t.metadata); } catch {}
  return { toolKey: t.toolKey, meta };
});

// 排除非生成的视频工具（增强/超分/擦除/抠图/动作控制）
const EXCLUDE = /enhance|upscal|eraser|matting|starlight|motion-control/;
const models = videoTools.filter((t) => !EXCLUDE.test(t.toolKey));
console.log("视频工具总数:", videoTools.length, "| 采集模型数:", models.length);
console.log("排除:", videoTools.filter((t) => EXCLUDE.test(t.toolKey)).map((t) => t.toolKey).join(", "));

// 3) 计算器请求
async function calc(body) {
  try {
    const r = await page.fetch("https://api.liblib.tv/api/task/generation/power/calculator", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        token: auth.usertoken,
        webid: auth.webid || "",
        "x-language": "zh",
        "X-Log-ID": "scrape-" + Date.now(),
      },
      body: JSON.stringify(body),
      timeout: 25000,
    });
    let data = null;
    try { data = JSON.parse(r.body); } catch {}
    return { status: r.status, data };
  } catch (e) {
    return { status: -1, err: String(e).slice(0, 150) };
  }
}

function enumValues(prop) {
  if (!prop) return null;
  const en = prop.enum;
  if (!Array.isArray(en)) return null;
  return en.map((e) => (typeof e === "string" ? e : e.value));
}

// value 为接口提交值，label 为官网展示名（displayName，无则取 value 本身）
function enumItems(prop) {
  if (!prop) return null;
  const en = prop.enum;
  if (!Array.isArray(en)) return null;
  return en.map((e) => (typeof e === "string" ? { value: e, label: e } : { value: e.value, label: e.displayName != null ? e.displayName : String(e.value) }));
}

function pickMode(meta) {
  const cfg = meta.config || {};
  const setKeys = Object.keys(cfg.settings || {});
  const modeItems = Object.keys(meta.properties?.modeType?.items || {});
  // 优先文生视频
  if (setKeys.includes("text2video")) return { mode: "text2video", media: { imageList: [], videoList: [] } };
  // 其次按 modeType items 顺序挑一个生成模式
  const order = ["singleImage2video", "image2video", "frames2video", "mixed2video", "videoEdit2video", "multiFrame2video", "audio2video", "video2video", "videoExtend2video"];
  for (const m of order) {
    if (modeItems.includes(m) || setKeys.includes(m)) {
      const media = { imageList: [], videoList: [] };
      if (["singleImage2video", "image2video", "mixed2video", "multiFrame2video"].includes(m)) {
        media.imageList = [{ url: "https://example.com/ref.png", width: 1024, height: 1024 }];
      }
      if (["frames2video"].includes(m)) {
        media.imageList = [{ url: "https://example.com/ref1.png" }, { url: "https://example.com/ref2.png" }];
      }
      if (["videoEdit2video", "video2video", "videoExtend2video"].includes(m)) {
        media.videoList = [{ url: "https://example.com/ref.mp4", durationSec: 5 }];
      }
      if (["mixed2video"].includes(m)) {
        media.imageList = [{ url: "https://example.com/ref.png" }];
      }
      return { mode: m, media };
    }
  }
  return null;
}

function settingsForMode(meta, mode) {
  const cfg = meta.config || {};
  const s = cfg.settings;
  let keys;
  if (Array.isArray(s)) keys = s;
  else if (s && typeof s === "object") keys = s[mode] || [];
  else keys = [];
  return keys;
}

function valueFor(key, meta, mode) {
  // 参数字段名以 originalField 为准（如 ratio_t2v/resolution_txt 都映射到 ratio/resolution）
  const p = meta.properties || {};
  const prop = p[key];
  const field = (prop && prop.originalField) || key;
  // labels 为官网展示名；仅 resolution/quality 维度使用，params 提交仍用 values
  const items = enumItems(prop);
  const labels = items ? items.map((it) => it.label) : null;
  if (key === "duration") {
    // 时长策略：短档 4s（无则 5s，再无则最短）；长档 30s（无则最长）；短长相同只留一档
    let avail = null;
    if (prop && prop.enum !== undefined) {
      avail = enumValues(prop).map(Number).filter((n) => !isNaN(n));
    } else if (prop && prop.min != null && prop.max != null) {
      const step = prop.step || 1;
      avail = [];
      for (let v = prop.min; v <= prop.max + 1e-9; v = +((v + step).toFixed(6))) avail.push(+v.toFixed(6));
    }
    if (!avail || avail.length === 0) return null;
    const has = (n) => avail.includes(n);
    const short = has(4) ? 4 : has(5) ? 5 : Math.min(...avail);
    const long = has(30) ? 30 : Math.max(...avail);
    return { field, values: [...new Set([short, long])] };
  }
  // 滑块型（min/max/step，无 enum）
  if (prop && prop.enum === undefined && prop.min != null && prop.max != null) {
    const dv = prop.default != null ? prop.default : prop.min;
    return { field, values: [dv], labels: [String(dv)] };
  }
  const vals = enumValues(prop);
  if (!vals) return null;
  if (key === "ratio" || key === "ratio_t2v") {
    const v = vals.includes("16:9") ? "16:9" : vals.find((x) => x !== "auto" && x !== "adaptive") || vals[0];
    return { field, values: [v], labels: [v] };
  }
  if (key === "ratio_auto") return { field, values: ["auto"], labels: ["auto"] };
  if (key === "ratio_16_9") return { field, values: ["16:9"], labels: ["16:9"] };
  if (key === "resolution") {
    if (items) {
      const concrete = items.filter((it) => it.value !== "auto");
      if (concrete.length > 0) return { field, values: concrete.map((it) => it.value), labels: concrete.map((it) => it.label) };
      return { field, values: ["auto"], labels: [items[0].label] };
    }
    const concrete = vals.filter((v) => v !== "auto");
    return { field, values: concrete.length > 0 ? concrete : ["auto"], labels: concrete.length > 0 ? concrete : ["auto"] };
  }
  return { field, values: vals, labels: labels || vals.map(String) };
}

// 模型显示名统一为英文（以 modelKey 为键），与模型监控采集的 LIBLIB_VIDEO_DISPLAY 保持一致
const DISPLAY_NAME_MAP = {
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

// 4) 逐模型采集
const results = [];
const rawLog = [];
let totalReqs = 0, failedReqs = 0;

for (const [mi, t] of models.entries()) {
  const meta = t.meta;
  const modelKey = meta.modelKey || t.toolKey;
  const vendor = meta.modelVendor || "";
  const pick = pickMode(meta);
  const modelRec = {
    model: modelKey,
    displayName: DISPLAY_NAME_MAP[modelKey] || meta.modelName || modelKey,
    vendor,
    mode: pick ? pick.mode : null,
    entries: [],
    errors: [],
  };
  if (!pick) {
    modelRec.errors.push({ msg: "无可用生成模式" });
    results.push(modelRec);
    console.log(`[${mi + 1}/${models.length}] ${modelKey}: 无可用生成模式，跳过`);
    continue;
  }
  const { mode, media } = pick;
  const settingsKeys = settingsForMode(meta, mode);
  // 维度：ratio(固定) / resolution / duration / quality / 其他 settings 维度取默认
  // 以 originalField 归类（resolution_txt/quality_4k/quality_high 等别名都归到对应维度）
  const dims = { ratio: null, resolution: null, duration: [], quality: null, extra: {} };
  for (const k of settingsKeys) {
    const v = valueFor(k, meta, mode);
    if (!v) continue;
    const f = v.field;
    if (f === "ratio" || k.startsWith("ratio")) dims.ratio = v;
    else if (f === "resolution") dims.resolution = { values: v.values, labels: v.labels };
    else if (f === "duration") dims.duration = v.values;
    else if (f === "quality") dims.quality = { values: v.values, labels: v.labels };
    else dims.extra[k] = v;
  }
  if (dims.duration.length === 0) dims.duration = [undefined];
  // 分辨率仅「自适应(auto)」一档且未被 settings 引用的模型（如 Kling O1 文生视频）：显示官网名（自适应）
  if (!dims.resolution) {
    const rp = meta.properties?.resolution;
    if (rp && rp.enum !== undefined) {
      const items = enumItems(rp) || [];
      if (items.length === 1 && items[0].value === "auto") dims.resolution = { values: ["auto"], labels: [items[0].label] };
    }
  }
  if (!dims.resolution) dims.resolution = { values: [undefined], labels: [undefined] };
  if (!dims.quality) dims.quality = { values: [undefined], labels: [undefined] };

  const combos = [];
  const resPairs = dims.resolution.values.map((val, i) => (val === undefined ? { api: undefined, label: undefined } : { api: val, label: dims.resolution.labels[i] ?? String(val) }));
  const qualPairs = dims.quality.values.map((val, i) => (val === undefined ? { api: undefined, label: undefined } : { api: val, label: dims.quality.labels[i] ?? String(val) }));
  for (const dur of dims.duration) {
    for (const rp of resPairs) {
      for (const qp of qualPairs) {
        combos.push({ duration: dur, resolutionApi: rp.api, resolution: rp.label, qualityApi: qp.api, quality: qp.label });
      }
    }
  }
  console.log(`[${mi + 1}/${models.length}] ${modelKey} (${mode}): ${combos.length} 组合`);

  for (const c of combos) {
    const params = {
      prompt: "a cute cat walking in a park",
      modeType: mode,
      count: 1,
      imageList: media.imageList,
      videoList: media.videoList,
    };
    if (dims.ratio) params[dims.ratio.field] = dims.ratio.values[0];
    if (c.duration !== undefined) params.duration = c.duration;
    if (c.resolutionApi !== undefined && c.resolutionApi !== "auto") params.resolution = c.resolutionApi;
    if (c.qualityApi !== undefined) params.quality = c.qualityApi;
    for (const [k, v] of Object.entries(dims.extra)) {
      // 额外维度取枚举第一个（默认值），暂不枚举
      params[v.field] = v.values[0];
    }
    const body = {
      taskType: "video",
      model: modelKey,
      provider: vendor,
      params,
      metadata: { node_id: "", project_id: "" },
      requestId: "scrape-" + Math.random().toString(36).slice(2, 10),
    };
    totalReqs++;
    const r = await calc(body);
    if (r.status === 200 && r.data?.code === 0 && typeof r.data.data?.power === "number") {
      modelRec.entries.push({
        mode,
        duration: c.duration,
        resolution: c.resolution,
        quality: c.quality,
        power: r.data.data.power,
      });
    } else if (r.status === 200 && r.data?.code === 1200000417) {
      // 会员专享档位：非会员账号无法查询积分
      modelRec.entries.push({
        mode,
        duration: c.duration,
        resolution: c.resolution,
        quality: c.quality,
        power: null,
        memberOnly: true,
      });
    } else {
      failedReqs++;
      modelRec.errors.push({
        duration: c.duration,
        resolution: c.resolution,
        quality: c.quality,
        status: r.status,
        code: r.data?.code,
        msg: r.data?.msg || r.err,
      });
    }
    rawLog.push({ model: modelKey, mode, combo: c, params, resp: r.status === 200 ? r.data : r.err });
    await wait(220);
  }
  results.push(modelRec);
}

// 5) 后处理：同 (resolution,duration) 下 quality 全等 → 合并 quality；再同 (duration) 下 resolution 全等 → 合并 resolution
for (const rec of results) {
  const byRes = {};
  for (const e of rec.entries) {
    const key = `${e.resolution}|${e.duration}`;
    (byRes[key] = byRes[key] || []).push(e);
  }
  const merged = [];
  for (const [key, list] of Object.entries(byRes)) {
    const [res, dur] = key.split("|");
    const uniqP = [...new Set(list.map((e) => e.power))];
    const base = { mode: list[0].mode, duration: dur === "undefined" ? undefined : (isNaN(Number(dur)) ? undefined : Number(dur)), resolution: res === "undefined" ? undefined : res, power: uniqP[0] };
    if (list.every((e) => e.memberOnly)) base.memberOnly = true;
    if (uniqP.length === 1) {
      const quals = list.map((e) => e.quality).filter(Boolean);
      base.quality = quals.length > 0 ? [...new Set(quals)].join("/") : undefined;
      merged.push(base);
    } else {
      for (const e of list) merged.push({ mode: e.mode, duration: e.duration, resolution: e.resolution, quality: e.quality, power: e.power, ...(e.memberOnly ? { memberOnly: true } : {}) });
    }
  }
  // 再合并 resolution（同 duration 下各 resolution 等价的才合并显示）
  const byDur = {};
  for (const e of merged) (byDur[`${e.duration}`] = byDur[`${e.duration}`] || []).push(e);
  const final = [];
  for (const [dur, list] of Object.entries(byDur)) {
    if (list.length > 1) {
      const uniqP = [...new Set(list.map((e) => e.power))];
      if (uniqP.length === 1) {
        final.push({ ...list[0], resolution: list.map((e) => e.resolution).filter(Boolean).join("/") || undefined });
        continue;
      }
    }
    final.push(...list);
  }
  rec.entries = final;
}

const output = {
  product: "liblib",
  collectedAt: new Date().toISOString(),
  settings: {
    ratio: "16:9",
    modeNote: "优先文生视频（text2video）；无文生视频的模型按其首个可用模式采集（图生视频等，使用示例占位图）",
    durationNote: "每模型两档时长：短档 4s（无则 5s，再无则最短）；长档 30s（无则最长）",
    resolutionNote: "分辨率/画质按官网展示名记录（如 std→720P、low→标准），接口提交仍用原始值；无分辨率档位的模型：仅自适应一档的记自适应；无分辨率维度的显示为默认",
    priceNote: "积分为单次生成算力（power/calculator 直查）；时长按秒线性计费；比例不影响价格；同价档位已合并显示；会员专享档位显示为「会员」",
  },
  totalReqs,
  failedReqs,
  models: results,
};
// 分辨率大小写统一为大写（720p→720P 等），保证筛选项合并
const normRes = (r) => String(r).replace(/(\d+(?:\.\d+)?)([pk])\b/gi, (m, n, s) => n + s.toUpperCase());
for (const m of output.models) for (const e of m.entries || []) if (e.resolution) e.resolution = normRes(e.resolution);

fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
fs.writeFileSync(RAW, JSON.stringify(rawLog, null, 2));
console.log("== 完成: 模型", results.length, "| 请求", totalReqs, "| 失败", failedReqs);
console.log("输出:", OUT);
console.log("DONE");
