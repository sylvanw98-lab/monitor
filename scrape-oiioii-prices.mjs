// scrape-oiioii-prices.mjs — 采集 oiioii 平台生图模型的积分价目
// 固定条件：比例 1:1、透明背景关、张数 1（张数 2/4 为线性 ×2/×4，已实测验证）
// 维度：模型 × 分辨率(1K/2K/4K) × 质量(Low/Medium/High)
import fs from "node:fs";

const URL = "https://www.oiioii.ai/space/490e95a3-0056-4f9f-a5a0-c4e63b5d7bb8";
const OUT = "D:/ai project/ai需求开发/dreamina-monitor/oiioii-prices.json";
const ONLY_MODEL = null; // 试跑时填单个模型名

// 站点显示名 → 官方模型名
const NAME_MAP = {
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

const task = await taskSpace("dreamina-page-verify");
let pages = await task.pages();
let page = pages[0] || (await task.newPage());

const wait = (ms) => page.waitForTimeout(ms);
const log = (...a) => console.log("[oiioii]", ...a);

async function evClick(fn) {
  return page.evaluate(fn);
}

// 按文本点击某选择器下的可见元素（取最后一个匹配），带重试
async function clickByText(sel, text) {
  for (let i = 0; i < 2; i++) {
    const ok = await page.evaluate(
      ([sel, text]) => {
        const els = [...document.querySelectorAll(sel)].filter(
          (e) =>
            (e.textContent || "").trim() === text &&
            (e.offsetParent !== null || e.getClientRects().length > 0)
        );
        if (!els.length) return false;
        els[els.length - 1].click();
        return true;
      },
      [sel, text]
    );
    if (ok) return true;
    await wait(400);
  }
  return false;
}

// 大小写不敏感版本（用于分辨率 1k/1K 等）
async function clickByTextCI(sel, text) {
  for (let i = 0; i < 2; i++) {
    const ok = await page.evaluate(
      ([sel, text]) => {
        const els = [...document.querySelectorAll(sel)].filter(
          (e) =>
            (e.textContent || "").trim().toLowerCase() === text.toLowerCase() &&
            (e.offsetParent !== null || e.getClientRects().length > 0)
        );
        if (!els.length) return false;
        els[els.length - 1].click();
        return true;
      },
      [sel, text]
    );
    if (ok) return true;
    await wait(400);
  }
  return false;
}

async function tuneOpen() {
  return page.evaluate(() => {
    const b = document.querySelector("._tune-btn_as85o_122");
    if (!b) return "no-btn";
    return /active/.test((b.className || "").toString());
  });
}

async function openTunePopup() {
  for (let i = 0; i < 3; i++) {
    if (await tuneOpen()) return true;
    await evClick(() => {
      const b = document.querySelector("._tune-btn_as85o_122");
      b && b.click();
    });
    await wait(1500);
  }
  return tuneOpen();
}

async function readCredits() {
  return page.evaluate(() => {
    const bs = [...document.querySelectorAll("._credit-cost_1szzj_1")].filter(
      (b) => b.offsetParent !== null || b.getClientRects().length > 0
    );
    const b = bs.find((x) => x.closest(".hogi-asset-panel-overlay")) || bs[bs.length - 1] || bs[0];
    return b ? (b.textContent || "").trim().replace(/[^\d]/g, "") : "";
  });
}

async function collectModelNames() {
  const names = await page.evaluate(() => {
    return [...document.querySelectorAll("._model-name_6ksin_323")]
      .filter((e) => e.offsetParent !== null || e.getClientRects().length > 0)
      .map((e) => {
        const span = e.querySelector("span");
        let name = span ? span.textContent.trim() : e.textContent.trim();
        // 去掉角标
        name = name.replace(/\s*(New|Best|Limited Time:\s*[\d%]+\s*OFF)\s*$/i, "").trim();
        return name;
      })
      .filter(Boolean);
  });
  return names.map((n) => NAME_MAP[n] || n);
}

async function dropdownOpen() {
  const names = await collectModelNames();
  return names.length > 0;
}

async function openModelDropdown() {
  for (let i = 0; i < 3; i++) {
    if (await dropdownOpen()) return true;
    await evClick(() => {
      [...document.querySelectorAll("._select-btn_as85o_117")].forEach((b) => b.click());
    });
    await wait(1800);
  }
  return dropdownOpen();
}

async function selectModel(name) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await openModelDropdown())) return { error: "模型下拉打不开" };
    const clicked = await page.evaluate(
      ({ name, map }) => {
        const el = [...document.querySelectorAll("._model-name_6ksin_323")].find((e) => {
          const span = e.querySelector("span");
          let n = span ? span.textContent.trim() : e.textContent.trim();
          n = n.replace(/\s*(New|Best|Limited Time:\s*[\d%]+\s*OFF)\s*$/i, "").trim();
          n = map[n] || n;
          return n === name && (e.offsetParent !== null || e.getClientRects().length > 0);
        });
        if (!el) return false;
        (el.closest("[class*='model-info']") || el).click();
        return true;
      },
      { name, map: NAME_MAP }
    );
    if (!clicked) return { error: `下拉里找不到模型 ${name}` };
    // 等选中生效
    let ok = false;
    for (let i = 0; i < 6; i++) {
      await wait(1000);
      const cur = await page.evaluate(() => {
        const b = document.querySelector("._select-btn_as85o_117");
        return b ? (b.textContent || "").trim() : "";
      });
      if ((NAME_MAP[cur] || cur) === name) { ok = true; break; }
    }
    if (ok) return { ok: true };
    log(`模型 ${name} 未生效，重试 (${attempt + 1})`);
  }
  return { error: "模型切换未生效" };
}

async function getTuneItems() {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll("._resolution-item_1t7f3_218")]
      .filter((e) => e.offsetParent !== null || e.getClientRects().length > 0)
      .map((e) => (e.textContent || "").trim())
      .filter(Boolean);
    const resolutions = items.filter((t) => /^\d+(\.\d+)?K$/i.test(t)).map((t) => t.toUpperCase());
    const qualities = items.filter((t) => !/^\d+(\.\d+)?K$/i.test(t));
    const toggle = document.querySelector("._toggle-switch_1t7f3_358");
    return {
      resolutions: [...new Set(resolutions)],
      qualities: [...new Set(qualities)],
      toggleOn: !!toggle && (toggle.getAttribute("aria-checked") === "true" || /on/.test((toggle.className || "").toString())),
    };
  });
}

async function tuneLabel() {
  return page.evaluate(() => {
    const b = document.querySelector("._tune-btn_as85o_122");
    return b ? (b.textContent || "").trim().replace(/\s+/g, " ") : "";
  });
}

await page.goto(URL, { timeout: 60000 });
await page.waitForLoadState();
await wait(10000);

// 确保资产面板打开（面板内有模型选择按钮）；否则点击画布图片节点
let panelReady = false;
for (let i = 0; i < 4; i++) {
  panelReady = await page.evaluate(() => {
    const b = document.querySelector("._select-btn_as85o_117");
    return !!b && (b.offsetParent !== null || b.getClientRects().length > 0);
  });
  if (panelReady) break;
  const nodeBox = await page.evaluate(() => {
    const n = document.querySelector(".react-flow__node-canvas-node");
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (nodeBox) {
    await page.mouse.click(nodeBox.x, nodeBox.y);
  }
  await wait(3000);
}
if (!panelReady) throw new Error("资产面板打不开（点击画布节点无效）");
log("面板已打开");

// 收集模型列表
if (!(await openModelDropdown())) {
  throw new Error("模型下拉打不开，无法开始");
}
const allModels = await collectModelNames();
log(`发现 ${allModels.length} 个模型: ${allModels.join(", ")}`);
const models = ONLY_MODEL ? allModels.filter((m) => m === ONLY_MODEL) : allModels;

const result = { scrapedAt: new Date().toISOString(), platform: "oiioii", settings: {}, models: [] };
const failedModels = [];

for (const [mi, model] of models.entries()) {
  log(`[${mi + 1}/${models.length}] ${model}`);
  try {
    const sel = await selectModel(model);
    if (sel.error) throw new Error(sel.error);
    await wait(1500);

    const popOpen = await openTunePopup();
    const label = await tuneLabel();
    const items = await getTuneItems();

    // 固定条件：比例 1:1、张数 1、透明背景关
    await clickByText("._ratio-item_1t7f3_53", "1:1");
    await wait(300);
    await clickByText("._generation-count-item_1t7f3_515", "1");
    await wait(300);
    if (items.toggleOn) {
      await evClick(() => {
        const t = document.querySelector("._toggle-switch_1t7f3_358");
        t && t.click();
      });
      await wait(500);
    }

    const entries = [];
    const quals = items.qualities.length ? items.qualities : [null];
    const reses = items.resolutions.length ? items.resolutions : [null];

    for (const q of quals) {
      for (const r of reses) {
        if (q) { await clickByText("._resolution-item_1t7f3_218", q); await wait(500); }
        if (r) { await clickByTextCI("._resolution-item_1t7f3_218", r); await wait(600); }
        const c = await readCredits();
        entries.push({
          resolution: r || "默认",
          quality: q || "默认",
          credits: c ? parseInt(c, 10) : null,
          raw: c || null,
        });
      }
    }

    result.models.push({
      name: model,
      entries,
      popOpen,
      tuneLabel: label,
      ...(items.resolutions.length === 0
        ? { note: "该模型无分辨率选项，仅记录默认档（见 tuneLabel）" }
        : {}),
    });
    log(`  ${entries.length} 条: ${entries.map((e) => `${e.resolution}/${e.quality}=${e.credits}`).join(" ")}`);
  } catch (err) {
    log(`  失败: ${err.message}`);
    failedModels.push(model);
    result.models.push({ name: model, entries: [], error: String(err.message) });
  }
}

result.settings = {
  ratio: "1:1",
  count: 1,
  transparent: false,
  countNote: "张数 2/4 积分线性 ×2/×4",
  failedModels,
};
fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
log(`完成：${result.models.length - failedModels.length}/${result.models.length} 个模型成功，已写入 ${OUT}`);
if (failedModels.length) {
  log("失败模型: " + failedModels.join(", "));
}
if (failedModels.length === models.length) throw new Error("全部模型抓取失败");
console.log(JSON.stringify(result, null, 2).slice(0, 4000));
