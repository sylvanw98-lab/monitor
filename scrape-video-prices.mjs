const BASE = "D:/ai project/ai需求开发/dreamina-monitor";
const fs = await import("node:fs/promises");

const PAGE_URL = "https://dreamina.capcut.com/ai-tool/home?type=video";
const PROMPT =
  "Ne Zha appears as a young boy with neat double buns tied with red ribbons. He has lively eyes and a confident expression. He wears classic red-and-black attire, with a red Huntian Silk Ribbon gently draped over his shoulders and arms, and a golden Qiankun Circle at his waist. Standing naturally, Ne Zha holds steady a hardcover notebook with a solid green cover in both hands. The cover is clean, with no text, patterns or logos. The shot slowly zooms in from a medium frame. Ne Zha lifts his eyes gently to look toward the camera. The Huntian Silk Ribbon sways softly in the breeze, and the notebook stays clearly centered in the frame. Chinese mythological theme, cinematic high-quality 3D animation, soft natural lighting, fine textures, smooth movements, stable shot, consistent character design throughout.";

const MODEL_NAMES = [
  "Dreamina Seedance 2.5 Draft",
  "Dreamina Seedance 2.5",
  "Dreamina Recreate",
  "Dreamina Seedance 2.0 Mini",
  "Dreamina Seedance 2.0 Fast",
  "Dreamina Seedance 2.0",
  "Dreamina Seedance 1.5 Pro",
  "Dreamina Seedance 1.0 Mini",
];

const REF_CHAIN = ["Omni reference", "First and last frames"];

async function waitReady(page) {
  await page.waitForFunction(
    () => {
      const cb = document.querySelector('[role="combobox"][aria-label="Model"]');
      const loading = [...document.querySelectorAll("button")].some((b) =>
        (b.textContent || "").includes("Loading...")
      );
      return !loading && !!cb && cb.getAttribute("aria-disabled") !== "true";
    },
    undefined,
    { timeout: 60000 }
  );
}

async function openModelDropdown(page) {
  await page.evaluate(() => {
    const cb = document.querySelector('[role="combobox"][aria-label="Model"]');
    if (cb) cb.click();
  });
  await page.waitForTimeout(1500);
  const open = await page.evaluate(() =>
    [...document.querySelectorAll('[role="listbox"] [role="option"], .lv-select-option')].some(
      (o) => o.offsetParent !== null || o.getClientRects().length > 0
    )
  );
  if (!open) {
    await page.click('loc=css:[role="combobox"][aria-label="Model"]', {
      label: "open model dropdown",
    });
    await page.waitForTimeout(1500);
  }
}

async function closeDropdowns(page) {
  const open = await page.evaluate(() =>
    [...document.querySelectorAll(".lv-select-option")].some(
      (o) => o.offsetParent !== null || o.getClientRects().length > 0
    )
  );
  if (open) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function selectModel(page, name) {
  await openModelDropdown(page);
  const r = await page.evaluate((name) => {
    const opts = [...document.querySelectorAll('[role="listbox"] [role="option"], .lv-select-option')]
      .filter((o) => o.offsetParent !== null || o.getClientRects().length > 0);
    const opt = opts.find((o) => {
      const label = o.querySelector(".select-option-label-content-SVQn5v");
      const t = label ? label.textContent.trim() : (o.textContent || "").trim();
      if (!t.startsWith(name)) return false;
      const next = t[name.length];
      return next === undefined || next !== " ";
    });
    if (!opt) return { error: "option not found" };
    opt.click();
    return { ok: true };
  }, name);
  if (r.error) throw new Error(r.error);
  await page.waitForFunction(
    (name) => {
      const cb = document.querySelector('[role="combobox"][aria-label="Model"]');
      const t = cb ? (cb.textContent || "").trim().replace(/\s+/g, " ") : "";
      return t === name;
    },
    name,
    { timeout: 15000 }
  );
  await page.waitForTimeout(2500);
  await closeDropdowns(page);
}

async function setReference(page) {
  const read = () =>
    page.evaluate(() => {
      const sels = [...document.querySelectorAll(".lv-select")];
      const v = (s) => s.querySelector(".lv-select-view-value");
      return sels.map((s) => (v(s) ? v(s).textContent.trim().replace(/\s+/g, " ") : ""));
    });
  // 若模型下拉还开着（切换模型后偶发未自动关闭），先关掉
  const modelDropdownOpen = await page.evaluate(() =>
    [...document.querySelectorAll(".lv-select-option")].some(
      (o) =>
        (o.offsetParent !== null || o.getClientRects().length > 0) &&
        (o.textContent || "").trim().startsWith("Dreamina")
    )
  );
  if (modelDropdownOpen) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(600);
  }
  const before = await read();
  // 参考类型下拉 = 值不含 "Dreamina" 的那个 select（模型下拉的值以 Dreamina 开头）
  const refIdx = before.findIndex((t) => t && !/^Dreamina/.test(t));
  if (refIdx < 0) return { used: null, verified: true };
  const current = before[refIdx] || "";
  if (current === REF_CHAIN[0]) return { used: current, verified: true };
  await page.evaluate((idx) => {
    const sels = [...document.querySelectorAll(".lv-select")];
    if (sels[idx]) sels[idx].click();
  }, refIdx);
  await page.waitForTimeout(1200);
  const r = await page.evaluate((chain) => {
    const visible = (o) => o.offsetParent !== null || o.getClientRects().length > 0;
    const opts = [...document.querySelectorAll(".lv-select-option, [role='listbox'] [role='option']")]
      .filter(visible)
      .map((o) => ({
        text: (o.textContent || "").trim().replace(/\s+/g, " "),
        el: o,
      }));
    let pick = null;
    for (const t of chain) {
      pick = opts.find((o) => o.text === t);
      if (pick) break;
    }
    if (!pick) {
      const isModelDropdown = opts.some((o) => o.text.startsWith("Dreamina"));
      if (isModelDropdown) return { error: "no ref select" };
      if (opts.length) {
        pick = opts[0];
        return { ok: true, used: pick.text, fallback: true };
      }
      return { error: "no options" };
    }
    pick.el.click();
    return { ok: true, used: pick.text };
  }, REF_CHAIN);
  if (r.error) throw new Error(r.error);
  await page.waitForTimeout(800);
  await closeDropdowns(page);
  const after = await read();
  const verified = after[refIdx] !== undefined && (after[refIdx] || "") === r.used;
  return { used: r.used, verified };
}

async function openSizePopup(page) {
  const isOpen = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[role="radiogroup"]')].some(
        (g) => g.offsetParent !== null || g.getClientRects().length > 0
      )
    );
  if (await isOpen()) return;
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /\d+:\d+/.test(b.textContent || "")
    );
    if (!btn) return { error: "size button not found" };
    btn.click();
    return { ok: true };
  });
  if (clicked.error) throw new Error(clicked.error);
  await page.waitForFunction(
    () => [...document.querySelectorAll('[role="radiogroup"]')].some(
      (g) => g.offsetParent !== null || g.getClientRects().length > 0
    ),
    undefined,
    { timeout: 10000 }
  );
  await page.waitForTimeout(500);
}

async function closeSizePopup(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
}

// Recreate 模式的分辨率弹窗：触发按钮文本形如 "1080P"（无比例按钮）
async function openResPopup(page) {
  const isOpen = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[role="radiogroup"]')].some(
        (g) => g.offsetParent !== null || g.getClientRects().length > 0
      )
    );
  if (await isOpen()) return;
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /^\d{3,4}\s?P$/.test((b.textContent || "").trim())
    );
    if (!btn) return { error: "resolution button not found" };
    btn.click();
    return { ok: true };
  });
  if (clicked.error) throw new Error(clicked.error);
  await page.waitForFunction(
    () => [...document.querySelectorAll('[role="radiogroup"]')].some(
      (g) => g.offsetParent !== null || g.getClientRects().length > 0
    ),
    undefined,
    { timeout: 10000 }
  );
  await page.waitForTimeout(500);
}

async function setRatio(page, ratio) {
  await openSizePopup(page);
  const r = await page.evaluate((ratio) => {
    const inputs = [...document.querySelectorAll('input[type="radio"]')].filter(
      (i) => i.offsetParent !== null || i.getClientRects().length > 0
    );
    const input = inputs.find((i) => i.value === ratio);
    if (!input) return { error: "ratio radio not found", values: inputs.map((i) => i.value) };
    const target = input.closest("label") || input;
    target.click();
    return { ok: true, checkedAfter: input.checked };
  }, ratio);
  if (r.error) throw new Error(`${r.error}: ${JSON.stringify(r.values)}`);
  await page.waitForTimeout(500);
  const confirm = await page.evaluate((ratio) => {
    const inputs = [...document.querySelectorAll('input[type="radio"]')].filter(
      (i) => i.offsetParent !== null || i.getClientRects().length > 0
    );
    const input = inputs.find((i) => i.value === ratio);
    return input ? input.checked : false;
  }, ratio);
  if (!confirm && !r.checkedAfter) {
    await page.evaluate((ratio) => {
      const input = [...document.querySelectorAll('input[type="radio"]')].find(
        (i) => i.value === ratio
      );
      if (input) input.click();
    }, ratio);
    await page.waitForTimeout(500);
  }
}

async function getResolutions(page) {
  return page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input[type="radio"]')].filter(
      (i) => i.offsetParent !== null || i.getClientRects().length > 0
    );
    return inputs
      .map((i) => i.value)
      .filter((v) => /^\d+p$/i.test(v))
      .map((v) => v.toUpperCase());
  });
}

async function clickResolution(page, res) {
  const r = await page.evaluate((res) => {
    const inputs = [...document.querySelectorAll('input[type="radio"]')].filter(
      (i) => i.offsetParent !== null || i.getClientRects().length > 0
    );
    const input = inputs.find((i) => i.value.toLowerCase() === res.toLowerCase());
    if (!input) return { error: "resolution radio not found" };
    const target = input.closest("label") || input;
    target.click();
    return { ok: true };
  }, res);
  if (r.error) throw new Error(r.error);
  await page.waitForTimeout(600);
}

async function isDurationOpen(page) {
  return page.evaluate(() => {
    const visible = (o) => o.offsetParent !== null || o.getClientRects().length > 0;
    const inners = [...document.querySelectorAll(".lv-popover-inner-content")].filter(visible);
    return inners.some((inner) =>
      inner.querySelector('[class*="duration-panel"], [role="slider"], [class*="tick-button"]')
    );
  });
}

async function openDuration(page) {
  await closeDropdowns(page);
  for (let i = 0; i < 3; i++) {
    if (await isDurationOpen(page)) return true;
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) =>
        /^\d+s$/.test((x.textContent || "").trim())
      );
      if (b) b.click();
    });
    await page.waitForTimeout(1800);
  }
  return isDurationOpen(page);
}

function findDurationInner() {
  const visible = (o) => o.offsetParent !== null || o.getClientRects().length > 0;
  return [...document.querySelectorAll(".lv-popover-inner-content")]
    .filter(visible)
    .find((inner) =>
      inner.querySelector('[class*="duration-panel"], [role="slider"], [class*="tick-button"]')
    );
}

async function getDurationTicks(page) {
  if (!(await openDuration(page))) return { error: "duration popover not open" };
  return page.evaluate(() => {
    const inner = (() => {
      const visible = (o) => o.offsetParent !== null || o.getClientRects().length > 0;
      return [...document.querySelectorAll(".lv-popover-inner-content")]
        .filter(visible)
        .find((i) =>
          i.querySelector('[class*="duration-panel"], [role="slider"], [class*="tick-button"]')
        );
    })();
    if (!inner) return { error: "popover not found" };
    const ticks = [...inner.querySelectorAll('[class*="tick-button"]')]
      .map((b) => Number((b.textContent || "").trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return { ticks: [...new Set(ticks)].sort((a, b) => a - b) };
  });
}

async function getSliderState(page) {
  return page.evaluate(() => {
    const visible = (o) => o.offsetParent !== null || o.getClientRects().length > 0;
    const inner = [...document.querySelectorAll(".lv-popover-inner-content")]
      .filter(visible)
      .find((i) => i.querySelector('[role="slider"]'));
    const slider = inner ? inner.querySelector('[role="slider"]') : null;
    if (!slider) return null;
    return {
      min: parseInt(slider.getAttribute("aria-valuemin"), 10),
      max: parseInt(slider.getAttribute("aria-valuemax"), 10),
      now: parseInt(slider.getAttribute("aria-valuenow"), 10),
    };
  });
}

async function setDuration(page, secs) {
  if (!(await openDuration(page))) throw new Error("duration popover not open");
  const state = await getSliderState(page);
  if (!state) throw new Error("slider not found");
  if (state.now === secs) return `${secs}s`;
  const tickClicked = await page.evaluate((secs) => {
    const visible = (o) => o.offsetParent !== null || o.getClientRects().length > 0;
    const inner = [...document.querySelectorAll(".lv-popover-inner-content")]
      .filter(visible)
      .find((i) => i.querySelector('[role="slider"], [class*="tick-button"]'));
    if (!inner) return false;
    const btn = [...inner.querySelectorAll('[class*="tick-button"]')].find(
      (b) => (b.textContent || "").trim() === String(secs)
    );
    if (!btn) return false;
    btn.click();
    return true;
  }, secs);
  if (!tickClicked) {
    await page.evaluate(() => {
      const visible = (o) => o.offsetParent !== null || o.getClientRects().length > 0;
      const inner = [...document.querySelectorAll(".lv-popover-inner-content")]
        .filter(visible)
        .find((i) => i.querySelector('[role="slider"]'));
      const slider = inner ? inner.querySelector('[role="slider"]') : null;
      if (slider) slider.focus();
    });
    const diff = secs - state.now;
    const key = diff > 0 ? "ArrowRight" : "ArrowLeft";
    for (let i = 0; i < Math.abs(diff); i++) {
      await page.keyboard.press(key).catch(() => {});
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(600);
  }
  const after = await getSliderState(page);
  if (!after || after.now !== secs) {
    throw new Error(`duration set failed: want ${secs}s, got ${after ? after.now + "s" : "?"}`);
  }
  return `${secs}s`;
}

async function closeDuration(page) {
  if (!(await isDurationOpen(page))) return;
  await page.mouse.click(500, 420).catch(() => {});
  await page.waitForTimeout(500);
  if (await isDurationOpen(page)) {
    await page.mouse.click(600, 300).catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function priceText(page) {
  return page.evaluate(() => {
    const el = document.querySelector('span[class*="credit-price-display"]');
    return el ? (el.textContent || "").trim() : "";
  });
}

async function waitPriceChange(page, before) {
  try {
    await page.waitForFunction(
      (before) => {
        const el = document.querySelector('span[class*="credit-price-display"]');
        return el && (el.textContent || "").trim() !== before;
      },
      before,
      { timeout: 3000 }
    );
  } catch {}
}

async function readPrice(page) {
  return page.evaluate(() => {
    const containers = [...document.querySelectorAll('div[class*="toolbar-actions"]')].filter(
      (c) => /^\s*\d/.test((c.textContent || "").trim())
    );
    const cont = containers[containers.length - 1];
    if (!cont) return { error: "price container not found" };
    const nums = [];
    const walker = document.createTreeWalker(cont, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = (walker.currentNode.textContent || "").trim();
      if (!/\d/.test(t)) continue;
      const m = t.match(/(\d+(?:\.\d+)?)/);
      if (m) {
        let el = walker.currentNode.parentElement;
        let struck = false;
        while (el && el !== cont) {
          if (getComputedStyle(el).textDecorationLine.includes("line-through")) struck = true;
          el = el.parentElement;
        }
        nums.push({ text: m[1], struck });
      }
    }
    const price = nums.find((n) => !n.struck);
    const original = nums.find((n) => n.struck);
    return {
      raw: (cont.textContent || "").trim(),
      price: price ? price.text : nums.length ? nums[0].text : null,
      original: original ? original.text : null,
      parts: nums.map((n) => `${n.text}${n.struck ? "(s)" : ""}`).join(" "),
    };
  });
}

async function fillPrompt(page) {
  const editorExists = await page.evaluate(
    () => !!document.querySelector('div[contenteditable="true"][role="textbox"]')
  );
  if (!editorExists) {
    console.warn({ promptFilled: false, reason: "no text editor (该模型可能不支持文本提示词)" });
    return false;
  }
  try {
    await page.fill('loc=css:div[contenteditable="true"][role="textbox"]', PROMPT);
  } catch {}
  const filled = await page.evaluate(() => {
    const ed = document.querySelector('div[contenteditable="true"][role="textbox"]');
    return ed ? (ed.textContent || "").trim() : "";
  });
  if (filled.includes("Ne Zha")) return true;
  await page.evaluate((prompt) => {
    const ed = document.querySelector('div[contenteditable="true"][role="textbox"]');
    if (!ed) return;
    ed.focus();
    const sel = window.getSelection();
    sel.selectAllChildren(ed);
    document.execCommand("insertText", false, prompt);
  }, PROMPT);
  const filled2 = await page.evaluate(() => {
    const ed = document.querySelector('div[contenteditable="true"][role="textbox"]');
    return ed ? (ed.textContent || "").trim() : "";
  });
  if (!filled2.includes("Ne Zha")) {
    console.warn({ promptFilled: false, editorText: filled2.slice(0, 80) });
  }
  return filled2.includes("Ne Zha");
}

async function ensurePromptFilled(page) {
  const has = await page.evaluate(() => {
    const ed = document.querySelector('div[contenteditable="true"][role="textbox"]');
    return ed ? (ed.textContent || "").includes("Ne Zha") : false;
  });
  if (!has) {
    const ok = await fillPrompt(page);
    if (!ok) return false;
  }
  return true;
}

const task = await taskSpace("dreamina-video-prices");
console.log({ taskSpaceId: task.spaceId });

let page = (await task.pages()).find((p) => p.label === "p1");
if (!page) {
  const pages = await task.pages();
  page = pages[0] || (await task.newPage());
}

const ONLY_MODEL = null; // 试跑时改成单个模型名，例如 "Dreamina Seedance 2.5"
const modelList = ONLY_MODEL ? [ONLY_MODEL] : MODEL_NAMES;

const result = {
  scrapedAt: new Date().toISOString(),
  product: "dreamina",
  settings: {
    ratio: "4:3",
    durations: "4s + 最长可选（最长不超过30s）",
    reference: REF_CHAIN.join(" → "),
    count: 1,
    prompt: PROMPT,
  },
  models: [],
};

await page.goto(PAGE_URL, { timeout: 60000 });
await page.waitForLoadState();
await waitReady(page);
await fillPrompt(page);

for (const name of modelList) {
  const rec = { name, entries: [] };
  try {
    await selectModel(page, name);
    const promptOk = await ensurePromptFilled(page);
    rec.promptFilled = promptOk;

    // Recreate 模式：无比例/时长控件，只有分辨率选择，按分辨率记录价格
    const hasSizeBtn = await page.evaluate(() =>
      [...document.querySelectorAll("button")].some((b) => /\d+:\d+/.test(b.textContent || ""))
    );
    if (!hasSizeBtn) {
      const refShown = await page.evaluate(() => {
        const sels = [...document.querySelectorAll(".lv-select .lv-select-view-value")].map((v) =>
          v.textContent.trim()
        );
        return sels.find((v) => v && !v.includes("Dreamina")) || null;
      });
      rec.reference = refShown || null;
      rec.ratio = null;
      await openResPopup(page);
      const resList = await getResolutions(page);
      for (const res of resList) {
        const before = await priceText(page);
        await clickResolution(page, res);
        await waitPriceChange(page, before);
        const p = await readPrice(page);
        rec.entries.push({
          resolution: res,
          duration: null,
          price: p.price,
          original: p.original,
          raw: p.raw,
          parts: p.parts,
        });
        console.log({ name, mode: "recreate (resolution only)", res, price: p.price, original: p.original });
      }
      await closeSizePopup(page);
      if (rec.entries.length === 0) throw new Error("no entries found");
    } else {
      const ref = await setReference(page);
      rec.reference = ref.used;
      if (!ref.verified) console.warn({ name, refWarn: "verify failed", shown: ref.used });

      let ratioSet = false;
      let resList = [];
      try {
        await setRatio(page, "4:3");
        ratioSet = true;
        resList = await getResolutions(page);
        await closeSizePopup(page);
      } catch (e) {
        console.warn({ name, sizeWarn: String(e && e.message ? e.message : e) });
      }
      rec.ratio = ratioSet ? "4:3" : null;
      console.log({ name, reference: ref.used, ratio: rec.ratio, resolutions: resList });

      for (const res of resList.length ? resList : [null]) {
        if (res !== null) {
          await openSizePopup(page);
          await setRatio(page, "4:3");
          await clickResolution(page, res);
          await closeSizePopup(page);
        }

        const durInfo = await getDurationTicks(page);
        if (durInfo.error) throw new Error(durInfo.error);
        const ticks = durInfo.ticks;
        if (ticks.length === 0) throw new Error("no duration ticks");
        rec.durations = ticks.map((t) => `${t}s`);
        const sliderMax = Math.min(30, ticks[ticks.length - 1]);
        const targets = [...new Set([4, sliderMax])];

        for (const secs of targets) {
          if (!(await openDuration(page))) throw new Error("duration popover not open");
          const before = await priceText(page);
          await setDuration(page, secs);
          await waitPriceChange(page, before);
          const p = await readPrice(page);
          rec.entries.push({
            resolution: res,
            duration: `${secs}s`,
            price: p.price,
            original: p.original,
            raw: p.raw,
            parts: p.parts,
          });
          console.log({ name, res, dur: `${secs}s`, price: p.price, original: p.original });
        }
        await closeDuration(page);
      }
    }
    if (rec.entries.length === 0) throw new Error("no entries found");
  } catch (err) {
    rec.error = String(err && err.message ? err.message : err);
    console.error({ name, error: rec.error });
  }
  result.models.push(rec);
}

const okCount = result.models.filter((m) => m.entries.length > 0).length;
if (okCount === 0) {
  throw new Error("all models failed to scrape");
}

if (!ONLY_MODEL) {
  await fs.writeFile(`${BASE}/prices-video.json`, JSON.stringify(result, null, 2));
  console.log({ saved: true, scrapedAt: result.scrapedAt, okCount, total: result.models.length });
} else {
  // 单模型补抓：合并进已有文件（仅当该模型抓取成功）
  const rec = result.models[0];
  if (rec && rec.entries.length > 0) {
    try {
      const existing = JSON.parse(await fs.readFile(`${BASE}/prices-video.json`, "utf8"));
      const idx = existing.models.findIndex((m) => m.name === rec.name);
      if (idx >= 0) existing.models[idx] = rec;
      else existing.models.push(rec);
      existing.scrapedAt = result.scrapedAt;
      await fs.writeFile(`${BASE}/prices-video.json`, JSON.stringify(existing, null, 2));
      console.log({ merged: true, model: rec.name, entries: rec.entries.length });
    } catch (err) {
      console.log({ merged: false, reason: String(err.message) });
    }
  } else {
    console.log({ dryRun: true, okCount, total: result.models.length });
  }
}
