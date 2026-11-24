// 抓取 krea.ai/video 各模型视频生成的积分价格（16:9、短档 4s/5s + 长档 30s）
// 方式：接口直查 /api/jobs/estimate（scope:"video"）+ 从页面 bundle 读取模型能力表
// 接口 unavailable 的模型：在页面内按 krea 官方前端计费逻辑兜底（We()：billing rates → 积分；汇率优先 exchangeRate，缺失时按模型表 computeUnits 反推），标注 source
// 前置条件：浏览器 taskSpace "krea-explore" 已打开 https://www.krea.ai/video 并登录
import fs from "node:fs";

const task = await taskSpace("krea-explore");
let pages = await task.pages();
let page = pages[0];

const OUT = "D:/ai project/ai需求开发/dreamina-monitor/krea-video-prices.json";
const wait = (ms) => page.waitForTimeout(ms);

// 确保在视频页
if (!String(await page.evaluate(() => location.href)).startsWith("https://www.krea.ai/video")) {
  console.log("goto /video ...");
  await page.goto("https://www.krea.ai/video", { timeout: 60000 });
  await page.waitForLoadState();
  await wait(4000);
}

// 从页面已加载的 bundle 动态定位视频模型表（不硬编码 chunk 文件名，防前端改版失效）
const modelLoc = await page.evaluate(async () => {
  const chunks = performance
    .getEntriesByType("resource")
    .map((r) => r.name)
    .filter((n) => n.includes(location.origin) && /\/chunks\/.+\.js$/.test(n));
  for (const c of chunks) {
    try {
      const m = await import(c);
      for (const [ek, ev] of Object.entries(m)) {
        if (!ev || typeof ev !== "object" || Array.isArray(ev)) continue;
        const txt = JSON.stringify(ev).slice(0, 4000000);
        if (!txt.includes("minimax_hailuo23") || !txt.includes("veo31")) continue;
        const rows = Object.entries(ev).filter(([, v]) => v && typeof v === "object" && v.name && v.provider);
        if (rows.length < 20) continue;
        return { chunk: c, exportKey: ek, count: rows.length };
      }
    } catch {}
  }
  return null;
});
if (!modelLoc) throw new Error("视频模型表未找到（krea 前端可能改版）");
console.log("模型表定位:", modelLoc.chunk.split("/").pop(), "导出键", modelLoc.exportKey, "|", modelLoc.count, "个模型");

const modelTable = await page.evaluate(async (loc) => {
  const m = await import(loc.chunk);
  const Z = m[loc.exportKey];
  return Object.entries(Z).map(([key, v]) => ({
    key,
    name: v.name,
    provider: v.provider,
    showInDropdown: !!v.showInDropdown,
    defaultDuration: v.defaultDuration,
    supportedDurations: v.supportedDurations || null,
    defaultResolutionLabel: v.defaultResolutionLabel || null,
    freePlanDefaultResolutionLabel: v.freePlanDefaultResolutionLabel || null,
    supportedResolutions: v.supportedResolutions || null,
    visibility: v.visibilityRule?.visibility ?? (v.visibilityRule ? "flag" : "public"),
    computeUnits: typeof v.computeUnits === "number" ? v.computeUnits : null,
  }));
}, modelLoc);
console.log("模型表读取:", modelTable.length, "个模型");

// 可见模型：排除 hidden/internal
const models = modelTable.filter(
  (m) => m.visibility !== "hidden" && m.visibility !== "internal"
);
console.log("待采集:", models.length, "个");

// 时长策略：短档 4s（无则 5s，再无则最短档）；长档 30s（支持才有）
function pickDurations(m) {
  const d = m.supportedDurations;
  if (!d || !d.length) return [{ duration: null, note: "模型无时长档位，按接口默认" }];
  const picks = [];
  if (d.includes(4)) picks.push({ duration: 4, note: null });
  else if (d.includes(5)) picks.push({ duration: 5, note: "无 4s 档，取 5s" });
  else picks.push({ duration: Math.min(...d), note: `无 4s/5s 档，取最短 ${Math.min(...d)}s` });
  if (d.includes(30)) picks.push({ duration: 30, note: null });
  return picks;
}

// mode 兜底（同前端 Ve() 规则）
function fallbackMode(provider) {
  if (provider === "klingPro") return "pro";
  if (provider === "kling_2") return "master";
  if (provider === "kling_o3") return "std";
  if (["kling_o3_pro", "kling_o3_v2v_ref", "kling_o3_v2v_edit"].includes(provider)) return "pro";
  return null;
}

// 单次 API 查询（页面内）
async function apiEstimate(inputParams) {
  return await page.evaluate(async (params) => {
    const res = await fetch("/api/jobs/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    let json = null;
    try { json = await res.json(); } catch (e) {}
    return { status: res.status, json };
  }, { scope: "video", inputParams });
}

// 单模型采集：在页面上下文串行调用 estimate 接口
async function queryModel(m) {
  const picks = pickDurations(m);
  const resolutions = [];
  if (m.defaultResolutionLabel) resolutions.push(m.defaultResolutionLabel);
  if (m.freePlanDefaultResolutionLabel && !resolutions.includes(m.freePlanDefaultResolutionLabel))
    resolutions.push(m.freePlanDefaultResolutionLabel);
  const res0 =
    Array.isArray(m.supportedResolutions) && m.supportedResolutions.length
      ? m.supportedResolutions[0]
      : null;
  if (res0 && !resolutions.includes(res0)) resolutions.push(res0);

  const entries = [];
  const errors = [];

  // minimax_h3max_recast 特殊：无时长档位，接口需显式 resolution（仅 1080p 可用）
  if (m.provider === "minimax_h3max_recast") {
    const specials = [
      { duration: null, resolution: "1080p", note: "无时长档位；接口未传时长（≈按 1s 计费）" },
      { duration: 5, resolution: "1080p", note: "无 4s/30s 档，取 5s（$0.45/秒）" },
    ];
    for (const sp of specials) {
      const inputParams = { provider: m.provider, resolution: sp.resolution };
      if (sp.duration != null) inputParams.duration = sp.duration;
      const r = await apiEstimate(inputParams);
      if (r.status === 200 && r.json?.status === "ready" && typeof r.json.computeUnits === "number") {
        entries.push({
          duration: sp.duration,
          durationNote: sp.note,
          resolution: sp.resolution,
          credits: Math.ceil(r.json.computeUnits),
          computeUnits: r.json.computeUnits,
          isEstimated: !!r.json.isEstimated,
          source: "api",
        });
      } else {
        errors.push(`${m.name} ${JSON.stringify(inputParams)} -> ${r.json?.status ?? "HTTP " + r.status}`);
      }
      await wait(200);
    }
    return {
      name: m.name, provider: m.provider, inDropdown: m.showInDropdown,
      maxDuration: null, supportedDurations: m.supportedDurations,
      defaultResolutionLabel: m.defaultResolutionLabel, entries, errors,
    };
  }

  for (const p of picks) {
    let ok = false;
    const tried = [];
    for (const resolution of resolutions.length ? resolutions : [null]) {
      for (const mode of [null, fallbackMode(m.provider)]) {
        if (mode !== null && tried.includes(`mode:${mode}`)) continue;
        const inputParams = { provider: m.provider };
        if (p.duration != null) inputParams.duration = p.duration;
        if (resolution) inputParams.resolution = resolution;
        if (mode) inputParams.mode = mode;
        const key = JSON.stringify(inputParams);
        if (tried.includes(key)) continue;
        tried.push(key);
        const r = await apiEstimate(inputParams);
        if (r.status !== 200 || !r.json) {
          errors.push(`${m.name} ${JSON.stringify(inputParams)} HTTP ${r.status}`);
          continue;
        }
        if (r.json.status === "ready" && typeof r.json.computeUnits === "number") {
          entries.push({
            duration: p.duration,
            durationNote: p.note,
            resolution: resolution || "默认",
            credits: Math.ceil(r.json.computeUnits),
            computeUnits: r.json.computeUnits,
            isEstimated: !!r.json.isEstimated,
            source: "api",
          });
          ok = true;
          break;
        }
      }
      if (ok) break;
    }
    if (!ok) {
      entries.push({
        duration: p.duration,
        durationNote: p.note,
        resolution: resolutions.join("/") || "默认",
        credits: null,
        note: "接口 unavailable（可能需付费计划或组合不支持）",
        // 内部字段：已尝试的参数组合（JSON 化），供前端定价兜底使用，写盘前删除
        triedParams: tried.map((k) => JSON.parse(k)),
      });
    }
    await wait(200);
  }

  return {
    name: m.name, provider: m.provider, inDropdown: m.showInDropdown,
    maxDuration: m.supportedDurations ? Math.max(...m.supportedDurations) : null,
    supportedDurations: m.supportedDurations,
    defaultResolutionLabel: m.defaultResolutionLabel,
    entries, errors,
  };
}

const out = { models: [] };
for (let i = 0; i < models.length; i++) {
  const m = models[i];
  try {
    const rec = await queryModel(m);
    out.models.push(rec);
    const okCount = rec.entries.filter((e) => e.credits != null).length;
    console.log(
      `[${i + 1}/${models.length}] ${m.name} (${m.provider}): ${okCount}/${rec.entries.length} 档成功` +
        (rec.errors.length ? ` | ${rec.errors.length} 错误` : "")
    );
  } catch (e) {
    console.log(`[${i + 1}/${models.length}] ${m.name}: 异常 ${String(e)}`);
    out.models.push({ name: m.name, provider: m.provider, inDropdown: m.showInDropdown, entries: [], errors: [String(e)] });
  }
}

// ===== 前端定价兜底：接口 unavailable 的档位，按 krea 官方前端计费逻辑（We() 复现）计算 =====
const fbJobs = [];
for (const model of out.models) {
  for (const entry of model.entries) {
    if (entry.credits == null && entry.triedParams) {
      const src = models.find((x) => x.provider === model.provider) || {};
      fbJobs.push({
        rec: {
          provider: model.provider,
          name: model.name,
          defaultDuration: src.defaultDuration ?? null,
          supportedDurations: model.supportedDurations,
          defaultResolutionLabel: model.defaultResolutionLabel,
          supportedResolutions: src.supportedResolutions ?? null,
          computeUnits: src.computeUnits ?? null,
        },
        tried: entry.triedParams,
      });
    }
  }
}
console.log("兜底计算:", fbJobs.length, "个失败档位");

if (fbJobs.length) {
  // 动态定位 reg 注册表（video:provider → slug），不硬编码 chunk 名
  const regLoc = await page.evaluate(async () => {
    const chunks = performance
      .getEntriesByType("resource")
      .map((r) => r.name)
      .filter((n) => n.includes(location.origin) && /\/chunks\/.+\.js$/.test(n));
    for (const c of chunks) {
      try {
        const m = await import(c);
        for (const [ek, ev] of Object.entries(m)) {
          if (!ev || typeof ev !== "object" || Array.isArray(ev)) continue;
          const vKeys = Object.keys(ev).filter((k) => k.startsWith("video:"));
          if (vKeys.length >= 10 && typeof ev["video:minimax_hailuo23"] === "string") {
            return { chunk: c, exportKey: ek, count: vKeys.length };
          }
        }
      } catch {}
    }
    return null;
  });
  if (!regLoc) throw new Error("reg 注册表未找到（krea 前端可能改版）");
  console.log("reg 定位:", regLoc.chunk.split("/").pop(), "导出键", regLoc.exportKey, "|", regLoc.count, "个 video 条目");

  const fbResults = await page.evaluate(async (args) => {
    const { jobs, modelLoc, regLoc } = args;
    const [m, regM] = await Promise.all([import(modelLoc.chunk), import(regLoc.chunk)]);
    const F = m.K, f = m.it;
    const reg = regM[regLoc.exportKey];
    const buildKey = (inputParams, dimensionOrder) =>
      dimensionOrder.map((d) => inputParams[d] ?? "").join(":");
    // 计费（We 复现）：仅 billing 路径；汇率优先 exchangeRate，缺失时用 computeUnits 反推
    const we = (provider, inputParams, modelInfo) => {
      const slug = reg["video:" + provider];
      const n = slug ? F(slug)?.billing : null;
      const r = n && "estimate" in n ? (n.estimate ?? n) : n;
      if (!r || !f(r)) return { v: null, path: "none" };
      const key = buildKey(inputParams, r.dimensionOrder);
      const s2 = r.rates[key] ?? r.rates[""];
      if (s2 === void 0) return { v: null, path: "none" };
      const usd = r.perSecond === true ? s2 * (inputParams.duration ?? 1) : s2;
      let rate = r.exchangeRate ?? null;
      if (rate == null && modelInfo && typeof modelInfo.computeUnits === "number" && modelInfo.computeUnits > 0) {
        const defPrice = r.rates[buildKey(modelInfo.defaultParams, r.dimensionOrder)] ?? r.rates[""];
        if (typeof defPrice === "number" && defPrice > 0) rate = defPrice / modelInfo.computeUnits;
      }
      if (rate == null) return { v: null, path: "norexchange", s2, perSecond: r.perSecond === true, usd };
      return { v: Math.round(usd / rate), path: "billing", s2, perSecond: r.perSecond === true, usd };
    };
    const L = (e, dims) => e.defaultDuration ?? e.supportedDurations?.[0] ?? dims?.duration?.[0];
    const R = (e, dims) => e.defaultResolutionLabel ? e.defaultResolutionLabel : Array.isArray(e.supportedResolutions) ? e.supportedResolutions[0] : e.supportedResolutions ? Object.keys(e.supportedResolutions)[0] : dims?.resolution?.[0];
    const Ve = (provider, dims) => {
      switch (provider) {
        case "klingPro": return "pro";
        case "kling_2": return "master";
        case "kling_o3": return "std";
        case "kling_o3_pro": case "kling_o3_v2v_ref": case "kling_o3_v2v_edit": return "pro";
      }
      const mode = dims?.mode;
      if (mode?.length) return mode.includes("std") ? "std" : mode[0];
    };
    const He = (e) => { if (e?.length) return e.every((x) => typeof x === "boolean") ? false : e.every((x) => typeof x === "number") ? Math.min(...e) : e[0]; };
    // 前端默认输入参数（Ue 复现）
    const uDefault = (rec) => {
      const slug = reg["video:" + rec.provider];
      const n = slug ? F(slug)?.billing : null;
      const r = n && "estimate" in n ? (n.estimate ?? n) : n;
      const a = r && f(r) ? L(rec, r.dimensions) : L(rec);
      const o = r && f(r) ? R(rec, r.dimensions) : R(rec);
      const s = {};
      if (a !== void 0) s.duration = a;
      if (o !== void 0) s.resolution = o;
      if (r && f(r)) {
        const t = Ve(rec.provider, r.dimensions);
        if (t !== void 0) s.mode = t;
        if (r.dimensions.billableSeconds && a !== void 0) s.billableSeconds = a;
        for (const dim of r.dimensionOrder) {
          if (dim in s) continue;
          const h = He(r.dimensions[dim]);
          if (h !== void 0) s[dim] = h;
        }
      }
      return s;
    };
    return jobs.map((job) => {
      const def = uDefault(job.rec);
      const results = [];
      let winner = null;
      for (const combo of job.tried) {
        const params = { provider: job.rec.provider, ...def, ...combo };
        const w = we(job.rec.provider, params, { computeUnits: job.rec.computeUnits, defaultParams: def });
        results.push({ combo, params, ...w });
        if (!winner && w.v != null) winner = { combo, params, ...w };
      }
      return { ok: !!winner, winner, results };
    });
  }, { jobs: fbJobs, modelLoc, regLoc });

  // 合并兜底结果
  let fi = 0;
  for (const model of out.models) {
    for (const entry of model.entries) {
      if (entry.credits == null && entry.triedParams) {
        const fr = fbResults[fi++];
        delete entry.triedParams;
        if (fr.ok) {
          const w = fr.winner;
          entry.credits = w.v;
          entry.computeUnits = w.v;
          entry.isEstimated = false;
          entry.source = "billing";
          // 同价组合并显示（如 veo31 720p/1080p 同价）
          const same = fr.results.filter((x) => x.v === w.v);
          const resList = [...new Set(same.map((x) => x.combo.resolution || "默认"))];
          entry.resolution = resList.join("/");
          const modePart = w.params.mode ? `，mode=${w.params.mode}` : "";
          let pricePart = "";
          if (w.path === "billing" && w.s2 != null) {
            pricePart = `（${w.perSecond ? `$${w.s2}/秒` : `$${w.s2}/次`}${w.combo.duration != null ? ` × ${w.combo.duration}s` : ""}${modePart}）`;
          }
          entry.note = `接口 unavailable；价格为 krea 前端计费配置${pricePart}，与 krea 前端官方定价口径一致`;
          // 其余组合价格不同则补充说明
          const others = [...new Set(fr.results.filter((x) => x.v != null && x.v !== w.v).map((x) => `${x.combo.resolution || "默认"} = ${x.v}`))];
          if (others.length) entry.note += `（其他：${others.join("；")}）`;
        } else {
          entry.source = null;
          const usdInfo = fr.results.find((x) => x.usd != null);
          if (usdInfo) {
            const modePart = usdInfo.params.mode ? `，mode=${usdInfo.params.mode}` : "";
            entry.note = `接口 unavailable；krea 前端计费配置 ${usdInfo.perSecond ? `$${usdInfo.s2}/秒` : `$${usdInfo.s2}/次`}${modePart}，但无积分汇率（exchangeRate 缺失且 computeUnits 无法反推），无法换算为积分`;
          } else {
            entry.note = "平台无定价数据（接口 unavailable；前端计费配置中无此模型/组合）";
          }
        }
      }
    }
  }
  console.log("兜底完成:", fbResults.filter((x) => x.ok).length, "/", fbResults.length, "档位有价");
}

out.scrapedAt = new Date().toISOString();
out.platform = "krea";
out.page = "https://www.krea.ai/video";
out.settings = {
  ratio: "16:9",
  durations: "短档 4s（无 4s 取 5s，再无为最短档）+ 长档 30s（仅支持 30s 的模型）",
  resolution: "各模型默认分辨率（部分模型无分辨率维度，显示默认）",
  creditNote:
    "积分为 /api/jobs/estimate 接口返回 computeUnits 向上取整（source=api）；接口 unavailable 的档位按 krea 官方前端计费逻辑兜底（billing rates；汇率优先 exchangeRate，缺失时按模型表 computeUnits 反推，source=billing）；null = 平台无定价数据",
};
// 分辨率大小写统一为大写（720p→720P 等），保证筛选项合并
const normRes = (r) => String(r).replace(/(\d+(?:\.\d+)?)([pk])\b/gi, (m, n, s) => n + s.toUpperCase());
for (const m of out.models) for (const e of m.entries) if (e.resolution) e.resolution = normRes(e.resolution);

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log("已写入", OUT);
const totalOk = out.models.reduce((s, m) => s + m.entries.filter((e) => e.credits != null).length, 0);
console.log("汇总: 模型", out.models.length, "| 成功档位", totalOk);
console.log("DONE");
