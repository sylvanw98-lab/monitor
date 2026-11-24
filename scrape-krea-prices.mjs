// 抓取 krea.ai/image 各模型 × 参数（分辨率/质量/思考强度）的积分价格
// 方式：UI 切换参数（固定比例 1:1、张数 1），挂钩捕获 /api/jobs/estimate 的请求体与 computeUnits
// 前置条件：浏览器 taskSpace "krea-explore" 已打开 https://www.krea.ai/image 并登录
import fs from "node:fs";

const task = await taskSpace("krea-explore");
let pages = await task.pages();
let page = pages[0];

const OUT = "D:/ai project/ai需求开发/dreamina-monitor/krea-prices.json";

// 站点显示名 → 官方模型名（PLAN 保持站点名用于选择，记录时输出官方名）
const NAME_MAP = {
  "Flux 2 Klein": "Flux 2 Mini",
  "Z Image": "Z-Image",
  "Qwen Image 2512": "Qwen Image Max",
};
const wait = (ms) => page.waitForTimeout(ms);
const esc = () => page.keyboard.press("Escape");

// 确保在图片页（共享 taskSpace 可能停在 /video 等其他页面）
if (!String(await page.evaluate(() => location.href)).startsWith("https://www.krea.ai/image")) {
  console.log("goto /image ...");
  await page.goto("https://www.krea.ai/image", { timeout: 60000 });
  await page.waitForLoadState();
  await wait(5000);
}

async function installHook() {
  await page.evaluate(() => {
    window.__est = [];
    window.__estSeq = 0;
    const origFetch = window.fetch;
    window.fetch = async function (url, opts) {
      const u = String(url);
      if (u.includes("/api/jobs/estimate")) {
        let body = null;
        try {
          body = JSON.parse(opts && opts.body ? opts.body : "null");
        } catch (e) {
          body = opts && opts.body;
        }
        const res = await origFetch.apply(this, arguments);
        const cloned = res.clone();
        let json = null;
        try {
          json = await cloned.json();
        } catch (e) {}
        window.__est.push({ seq: ++window.__estSeq, body, status: res.status, json });
        return res;
      }
      return origFetch.apply(this, arguments);
    };
  });
}

// 在 fn 执行期间捕获新 estimate；返回最新一条或 null
async function capture(fn) {
  const before = await page.evaluate(() => window.__estSeq);
  await fn();
  await wait(1800);
  return page.evaluate(
    (b) => {
      const fresh = window.__est.filter((e) => e.seq > b);
      return fresh[fresh.length - 1] || null;
    },
    before
  );
}

// 张数 2→1 切换，触发一次估算（用于"点击当前档不触发"的兜底）
async function countToggleEstimate() {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".group\\/promptbox button")].find(
      (x) => x.getAttribute("aria-label") === "More images"
    );
    b && b.click();
  });
  await wait(1500);
  const est = await capture(async () => {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".group\\/promptbox button")].find(
        (x) => x.getAttribute("aria-label") === "Fewer images"
      );
      b && b.click();
    });
  });
  await wait(500);
  return est;
}

async function selectModel(name) {
  await page.evaluate(() => {
    const box = document.querySelector(".group\\/promptbox");
    if (!box) return;
    const modelBtn = [...box.querySelectorAll("button")].find((b) =>
      /Krea|Flux|GPT|Qwen|Nano|Recraft|Z Image|Wan|Kling|Runway|Ideogram/.test(b.textContent)
    );
    modelBtn && modelBtn.click();
  });
  await wait(1600);
  const r = await page.evaluate((nm) => {
    const dialog = [...document.querySelectorAll("[role=dialog]")].find((d) =>
      d.innerText.includes("Select models")
    );
    if (!dialog) return "no dialog";
    const cands = [...dialog.querySelectorAll("h4, button, div, span")].filter(
      (el) => el.children.length === 0 && el.textContent.trim() === nm
    );
    const t = cands[cands.length - 1];
    if (!t) return "not found";
    t.click();
    return "ok";
  }, name);
  await wait(2800);
  await esc();
  await wait(400);
  return r;
}

async function setRatio11() {
  const ratioText = await page.evaluate(() => {
    const box = document.querySelector(".group\\/promptbox");
    const b =
      box &&
      [...box.querySelectorAll("button")].find((x) => /^(\d+:\d+|Auto)$/.test(x.textContent.trim()));
    return b ? b.textContent.trim() : null;
  });
  if (!ratioText) return "no-ratio-btn";
  if (ratioText === "1:1") return "already";
  await page.hover(`.group\\/promptbox button:has-text('${ratioText}')`);
  await wait(1100);
  const est = await capture(() =>
    page.evaluate(() => {
      const cands = [...document.querySelectorAll("button, div, span")].filter(
        (el) => el.textContent.trim() === "1:1" && el.children.length <= 1
      );
      const t = cands[cands.length - 1];
      t && t.click();
    })
  );
  await wait(600);
  await page.mouse.move(0, 0);
  await wait(500);
  return est;
}

async function promptButtons() {
  return page.evaluate(() => {
    const box = document.querySelector(".group\\/promptbox");
    return box
      ? [...box.querySelectorAll("button")]
          .map((b) => ({
            text: b.textContent.trim().replace(/\s+/g, " ").slice(0, 15),
            aria: b.getAttribute("aria-label") || "",
          }))
          .filter((x) => x.text || x.aria)
      : [];
  });
}

// 读取当前参数按钮文本（res/qual/think）；res 支持小数档（1.2K/1.5K）
async function curBtnText(kind) {
  return page.evaluate((k) => {
    const box = document.querySelector(".group\\/promptbox");
    if (!box) return null;
    const btns = [...box.querySelectorAll("button")];
    let b = null;
    if (k === "res") b = btns.find((x) => /^\d+(\.\d+)?K$/.test(x.textContent.trim()));
    else if (k === "qual")
      b = btns.find((x) =>
        ["Low", "Medium", "High", "Extra High", "Max"].includes(x.textContent.trim())
      );
    else if (k === "think")
      b = btns.find((x) => (x.getAttribute("aria-label") || "").includes("Thinking effort"));
    return b ? b.textContent.trim() : null;
  }, kind);
}

// 菜单选项：文本 + 是否禁用（label 带 opacity-50 = group disabled）
async function menuOptions() {
  return page.evaluate(() => {
    const menus = [...document.querySelectorAll("[role=menu]")];
    const m = menus[menus.length - 1];
    if (!m) return [];
    return [...m.querySelectorAll("label")].map((l) => ({
      text: l.textContent.trim(),
      disabled: l.className.includes("opacity-50"),
    }));
  });
}

async function clickMenuOption(text) {
  return page.evaluate((t) => {
    const menus = [...document.querySelectorAll("[role=menu]")];
    const m = menus[menus.length - 1];
    if (!m) return "no menu";
    const label = [...m.querySelectorAll("label")].find((x) => x.textContent.trim() === t);
    if (!label) return "not found";
    if (label.className.includes("opacity-50")) return "disabled";
    const r = label.querySelector("button[role=radio]");
    (r || label).click();
    return "clicked-label";
  }, text);
}

async function openMenuByText(text) {
  return page.evaluate((t) => {
    const box = document.querySelector(".group\\/promptbox");
    const b = box && [...box.querySelectorAll("button")].find((x) => x.textContent.trim() === t);
    b && b.click();
  }, text);
}

// 打开按钮菜单并点击选项，失败重试一次
async function openAndClick(btnText, optText) {
  let last = "no menu";
  for (let i = 0; i < 2; i++) {
    await openMenuByText(btnText);
    await wait(900);
    last = await clickMenuOption(optText);
    if (last.startsWith("clicked") || last === "disabled") return last;
  }
  return last;
}

// 切换参数并捕获估算；若点击的是当前档（无估算），用张数切换兜底
async function switchAndCapture(kind, optText) {
  const curText = await curBtnText(kind);
  if (!curText) return null;
  let est = await capture(async () => {
    await openAndClick(curText, optText);
  });
  await esc();
  await wait(500);
  if (!est) {
    const after = await curBtnText(kind);
    if (after === optText) est = await countToggleEstimate();
  }
  return est;
}

function estToEntry(est, resolution = "默认", quality = "默认", thinking = null) {
  if (!est) return null;
  const ip = (est.body && est.body.inputParams) || {};
  const cu = est.json && typeof est.json.computeUnits === "number" ? est.json.computeUnits : null;
  return {
    resolution,
    quality,
    ...(thinking ? { thinking } : {}),
    credits: cu == null ? null : Math.ceil(cu),
    computeUnits: cu,
    isEstimated: !!(est.json && est.json.isEstimated),
    width: ip.width || null,
    height: ip.height || null,
    steps: ip.steps || null,
    provider: ip.provider || null,
  };
}

const PLAN = [
  { name: "Krea 3", thinking: true },
  { name: "Krea 2 Large" },
  { name: "Krea 2 Medium" },
  { name: "Krea 2 Turbo" },
  { name: "Krea 1" },
  { name: "Nano Banana 2 Lite" },
  { name: "Flux 2 Klein" },
  { name: "Recraft V4.1 Flash" },
  { name: "Qwen Image 2512" },
  { name: "GPT Image 2.6 Sunburst" },
  { name: "GPT Image 2.5 Sunburst" },
  { name: "Flux.1 Dev" },
  { name: "Z Image" },
  { name: "Flux 2 Max" },
  { name: "Wan 2.2 Image" },
  { name: "Qwen Image" },
  { name: "Kling o1 Image" },
  { name: "Flux Kontext Dev" },
  { name: "Flux Kontext Pro" },
  { name: "Runway Gen-4 Image" },
  { name: "Ideogram 3.0" },
  { name: "Flux 1.1 Pro" },
  { name: "Flux 1.1 Pro Ultra" },
];

const QUAL_NAMES = ["Low", "Medium", "High", "Extra High", "Max"];

await installHook();
const models = [];
for (const p of PLAN) {
  const rec = { name: NAME_MAP[p.name] || p.name, entries: [], errors: [], skipped: [] };
  try {
    const sel = await selectModel(p.name);
    if (sel !== "ok") {
      rec.errors.push("select:" + sel);
      models.push(rec);
      console.log(p.name, "SELECT FAIL", sel);
      continue;
    }
    const ratioEst = await setRatio11();
    await wait(800);
    const btns = await promptButtons();

    const resBtn = btns.find((b) => /^\d+(\.\d+)?K$/.test(b.text));
    const qualBtn = btns.find((b) => QUAL_NAMES.includes(b.text));
    const thinkBtn = btns.find((b) => b.aria.includes("Thinking effort"));

    // 基础档（1:1 默认参数；比例变化时触发）
    const baseEst = ratioEst === "already" || ratioEst === "no-ratio-btn" ? null : ratioEst;
    const base = estToEntry(baseEst || null);
    if (base) rec.entries.push(base);

    if (thinkBtn) {
      // 思考强度菜单（Krea 3）
      for (const o of ["Fast", "High", "Ultra"]) {
        const est = await switchAndCapture("think", o);
        const e = estToEntry(est, "默认", "默认", o);
        if (e) rec.entries.push(e);
        else
          rec.entries.push({
            resolution: "默认",
            quality: "默认",
            thinking: o,
            credits: null,
            note: "未触发估算（可能免费或需参考图）",
          });
        console.log(p.name, o, est ? est.json && est.json.computeUnits : null);
      }
    } else if (resBtn && qualBtn) {
      // 分辨率 × 质量矩阵（GPT 模型）
      await openMenuByText(resBtn.text);
      await wait(900);
      const resOptsRaw = await menuOptions();
      await esc();
      await wait(400);
      if (!resOptsRaw.length) rec.errors.push("no res options");
      for (const { text: r, disabled } of resOptsRaw) {
        if (disabled) {
          rec.skipped.push(r);
          console.log(p.name, r, "DISABLED skip");
          continue;
        }
        await switchAndCapture("res", r);
        for (const q of QUAL_NAMES) {
          const est = await switchAndCapture("qual", q);
          const e = estToEntry(est, r, q);
          if (e) rec.entries.push(e);
          else rec.errors.push(`${r}/${q} no estimate`);
          console.log(p.name, r, q, est ? est.json && est.json.computeUnits : null);
        }
      }
    } else if (resBtn) {
      // 仅分辨率
      await openMenuByText(resBtn.text);
      await wait(900);
      const resOptsRaw = await menuOptions();
      await esc();
      await wait(400);
      if (!resOptsRaw.length) rec.errors.push("no res options");
      for (const { text: r, disabled } of resOptsRaw) {
        if (disabled) {
          rec.skipped.push(r);
          console.log(p.name, r, "DISABLED skip");
          continue;
        }
        const est = await switchAndCapture("res", r);
        const e = estToEntry(est, r);
        if (e) rec.entries.push(e);
        else rec.errors.push(`${r} no estimate`);
        console.log(p.name, r, est ? est.json && est.json.computeUnits : null);
      }
    }

    // 无参数按钮模型：确保有一条 1:1 记录
    if (!rec.entries.length) {
      const est2 = await countToggleEstimate();
      const e = estToEntry(est2 || null);
      if (e) rec.entries.push(e);
      else rec.errors.push("no base estimate");
    }
    if (rec.skipped.length) rec.note = `${rec.skipped.join("、")} 档在 UI 中为禁用状态（模型不支持），不可选`;
    if (rec.entries.length) rec.provider = rec.entries[0].provider;
  } catch (err) {
    rec.errors.push("exception:" + err.message);
    console.log(p.name, "EXCEPTION", err.message);
  }
  models.push(rec);
  console.log("== done", p.name, rec.entries.length, "entries,", rec.errors.length, "errors,", rec.skipped.length, "skipped");
}

const payload = {
  scrapedAt: new Date().toISOString(),
  platform: "krea",
  settings: {
    ratio: "1:1",
    count: 1,
    countNote: "张数 N = 积分 ×N（线性，最多 4 张）",
    creditNote: "积分为 computeUnits 向上取整；~ 为估算值（isEstimated=true）",
  },
  models,
};
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log("saved", OUT, models.length, "models");
