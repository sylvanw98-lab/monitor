const BASE = "D:/ai project/ai需求开发/dreamina-monitor";
const fs = await import("node:fs/promises");

const PAGE_URL = "https://dreamina.capcut.com/ai-tool/home?type=image";
const PROMPT =
  "Ne Zha, young boy, double bun hairstyle tied with red ribbons, classic red-and-black Huntian silk ribbon, Qiankun Circle, bright and vivid eyes, standing naturally, holding a hardcover notebook with a solid green cover in both hands, the notebook is clean.";

const MODEL_NAMES = [
  "Seedream 5.0 Pro",
  "GPT Image 2.5 Flare",
  "GPT Image 2.5 Sunburst",
  "GPT Image 2",
  "Nano Banana Pro",
  "Seedream 5.0 Flash",
];

const QUALITY_NAMES = ["Low", "Medium", "High", "Ultra", "Max"];

async function waitModelCombobox(page) {
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
  const clicked = await page.evaluate(() => {
    const cb = document.querySelector('[role="combobox"][aria-label="Model"]');
    if (!cb) return { error: "model combobox not found" };
    cb.click();
    return { ok: true };
  });
  if (clicked.error) throw new Error(clicked.error);
  try {
    await page.waitForSelector('[role="listbox"]', {
      state: "visible",
      timeout: 5000,
    });
  } catch {
    const stillOpen = await page.evaluate(() =>
      !!document.querySelector('[role="listbox"]')
    );
    if (!stillOpen) {
      await page.click('loc=css:[role="combobox"][aria-label="Model"]', {
        label: "open model dropdown",
      });
      await page.waitForSelector('[role="listbox"]', {
        state: "visible",
        timeout: 30000,
      });
    }
  }
}

async function selectModel(page, name) {
  await openModelDropdown(page);
  const sel = await page.evaluate((name) => {
    const opts = [...document.querySelectorAll('[role="listbox"] [role="option"]')];
    const opt = opts.find((o) => (o.textContent || "").trim().startsWith(name));
    if (!opt) return { error: `option not found: ${name}` };
    opt.click();
    return { ok: true };
  }, name);
  if (sel.error) throw new Error(sel.error);
  await page.waitForFunction(
    (name) => {
      const cb = document.querySelector('[role="combobox"][aria-label="Model"]');
      return cb && (cb.textContent || "").includes(name);
    },
    name,
    { timeout: 15000 }
  );
}

async function ensureSizePopup(page) {
  const open = await page.evaluate(() => {
    return [...document.querySelectorAll('[role="radiogroup"]')].some(
      (g) => g.offsetParent !== null || g.getClientRects().length > 0
    );
  });
  if (open) return;
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => /\d+:\d+/.test(b.textContent || "") && /\dK|Custom/.test(b.textContent || "")
    );
    if (!btn) return { error: "size button not found" };
    btn.click();
    return { ok: true };
  });
  if (clicked.error) throw new Error(clicked.error);
  await page.waitForFunction(
    () => {
      return [...document.querySelectorAll('[role="radiogroup"]')].some(
        (g) => g.offsetParent !== null || g.getClientRects().length > 0
      );
    },
    undefined,
    { timeout: 10000 }
  );
}

async function getGroups(page) {
  return page.evaluate(() => {
    const groups = [...document.querySelectorAll('[role="radiogroup"]')].filter(
      (g) => g.offsetParent !== null || g.getClientRects().length > 0
    );
    return groups.map((g) => {
      const leaves = [...g.querySelectorAll("*")]
        .filter((el) => el.children.length === 0)
        .map((l) => (l.textContent || "").trim())
        .filter(Boolean);
      return leaves;
    });
  });
}

function findGroupIndex(groups, pred) {
  return groups.findIndex(pred);
}

async function clickGroupOption(page, groupIndex, target) {
  return page.evaluate(
    ({ gi, target }) => {
      const groups = [...document.querySelectorAll('[role="radiogroup"]')].filter(
        (g) => g.offsetParent !== null || g.getClientRects().length > 0
      );
      const group = groups[gi];
      if (!group) return { error: `group ${gi} not found` };
      const leaves = [...group.querySelectorAll("*")].filter(
        (el) => (el.textContent || "").trim() === target && el.children.length === 0
      );
      const leaf = leaves[leaves.length - 1];
      if (!leaf) return { error: `option not found: ${target}` };
      const clickable =
        leaf.closest('[role="radio"]') || leaf.closest("button") || leaf.parentElement || leaf;
      const cls = (el) => (el && el.getAttribute ? el.getAttribute("class") || "" : "");
      const before = cls(clickable);
      clickable.click();
      const radio = leaf.closest('[role="radio"]');
      const selected = [...group.querySelectorAll('[class*="checked"], [aria-checked="true"]')]
        .map((el) => (el.textContent || "").trim())
        .filter((t) => t && t.length <= 20);
      return {
        ok: true,
        tag: clickable.tagName,
        ariaChecked: radio ? radio.getAttribute("aria-checked") : null,
        clsBefore: before,
        clsAfter: cls(clickable),
        selected,
      };
    },
    { gi: groupIndex, target }
  );
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
  } catch {
    // 价格未变化（可能与上一分辨率同价），继续读取
  }
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
  try {
    await page.fill('loc=css:div[contenteditable="true"][role="textbox"]', PROMPT);
  } catch {
    // fallthrough to evaluate fallback
  }
  const filled = await page.evaluate(() => {
    const ed = document.querySelector('div[contenteditable="true"][role="textbox"]');
    return ed ? (ed.textContent || "").trim() : "";
  });
  if (filled.includes("Ne Zha")) return;
  await page.evaluate((prompt) => {
    const ed = document.querySelector('div[contenteditable="true"][role="textbox"]');
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
}

async function ensurePromptFilled(page) {
  const has = await page.evaluate(() => {
    const ed = document.querySelector('div[contenteditable="true"][role="textbox"]');
    return ed ? (ed.textContent || "").includes("Ne Zha") : false;
  });
  if (!has) await fillPrompt(page);
}

async function ensureCountOne(page) {
  const r = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")]
      .map((b) => (b.textContent || "").trim())
      .filter((t) => /^\d+$/.test(t));
    return btns;
  });
  if (r.length === 0 || (r.length === 1 && r[0] === "1")) return;
  const clicked = await page.evaluate(() => {
    const one = [...document.querySelectorAll("button")].find(
      (b) => (b.textContent || "").trim() === "1"
    );
    if (!one) return { error: "count button 1 not found" };
    one.click();
    return { ok: true };
  });
  if (clicked.error) console.warn({ countButtons: r, error: clicked.error });
  else console.log({ countButtons: r, setTo: 1 });
}

const task = await taskSpace("dreamina-price-scraper");
console.log({ taskSpaceId: task.spaceId });

let page = (await task.pages()).find((p) => p.label === "p1");
if (!page) {
  const pages = await task.pages();
  page = pages[0] || (await task.newPage());
}

const result = {
  scrapedAt: new Date().toISOString(),
  product: "dreamina",
  settings: { ratio: "1:1", count: 1, prompt: PROMPT },
  models: [],
};

await page.goto(PAGE_URL, { timeout: 60000 });
await page.waitForLoadState();
await waitModelCombobox(page);
await fillPrompt(page);
await ensureCountOne(page);

for (const name of MODEL_NAMES) {
  const rec = { name, entries: [] };
  try {
    await ensurePromptFilled(page);
    await selectModel(page, name);
    await ensureSizePopup(page);

    const groups = await getGroups(page);
    const ratioGi = findGroupIndex(groups, (leaves) =>
      leaves.some((t) => /^\d+:\d+$/.test(t))
    );
    const resGi = findGroupIndex(groups, (leaves) =>
      leaves.some((t) => /^\d(\.\d)?K$/.test(t))
    );
    const qualGi = findGroupIndex(groups, (leaves) =>
      leaves.some((t) => QUALITY_NAMES.includes(t))
    );

    if (ratioGi >= 0) {
      const r = await clickGroupOption(page, ratioGi, "1:1");
      console.log({ name, step: "ratio", ...r });
    }

    if (resGi < 0) throw new Error("resolution group not found");
    const resLeaves = groups[resGi].filter((t) => /^\d(\.\d)?K$/.test(t));
    const qualLeaves =
      qualGi >= 0 ? groups[qualGi].filter((t) => QUALITY_NAMES.includes(t)) : [null];
    for (const res of resLeaves) {
      const rBefore = await priceText(page);
      const rClicked = await clickGroupOption(page, resGi, res);
      await waitPriceChange(page, rBefore);
      const rAfter = await priceText(page);
      const rConfirmed = (rClicked.selected || []).some((t) => t.includes(res));
      if (rAfter === rBefore && !rConfirmed) {
        await clickGroupOption(page, resGi, res);
        await waitPriceChange(page, rAfter);
      }
      for (const qual of qualLeaves) {
        if (qual !== null) {
          const qBefore = await priceText(page);
          const qClicked = await clickGroupOption(page, qualGi, qual);
          await waitPriceChange(page, qBefore);
          const qConfirmed = (qClicked.selected || []).some((t) => t.includes(qual));
          if (!qConfirmed) {
            await clickGroupOption(page, qualGi, qual);
            await waitPriceChange(page, qBefore);
          }
        }
        const p = await readPrice(page);
        rec.entries.push({
          resolution: res,
          quality: qual,
          price: p.price,
          original: p.original,
          raw: p.raw,
          parts: p.parts,
        });
        console.log({ name, res, qual, price: p.price, original: p.original });
      }
    }
    if (rec.entries.length === 0) {
      throw new Error("no entries found");
    }
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

await fs.writeFile(`${BASE}/prices.json`, JSON.stringify(result, null, 2));
console.log({ saved: true, scrapedAt: result.scrapedAt, okCount, total: result.models.length });
