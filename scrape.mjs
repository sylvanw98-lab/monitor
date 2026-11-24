const BASE = "D:/ai project/ai需求开发/dreamina-monitor";
const fs = await import("node:fs/promises");

const SOURCES = [
  { type: "image", url: "https://dreamina.capcut.com/ai-tool/home?type=image" },
  { type: "video", url: "https://dreamina.capcut.com/ai-tool/home?type=video" },
];

const EXCLUDED_IMAGE_MODELS = new Set([
  "Seedream 4.6",
  "Seedream 4.5",
  "Seedream 4.1",
  "Seedream 4.0",
  "Seedream 3.0",
]);

async function extractModelList(page) {
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
  return page.evaluate(() => {
    const opts = [...document.querySelectorAll('[role="listbox"] [role="option"]')];
    return opts.map((o) => {
      const walker = document.createTreeWalker(o, NodeFilter.SHOW_TEXT);
      const texts = [];
      while (walker.nextNode()) {
        const t = (walker.currentNode.textContent || "").trim();
        if (t) texts.push(t);
      }
      const lines = texts.filter((s, i) => s !== texts[i - 1]);
      const name = lines[0] || "";
      const isNew = lines.includes("New");
      const desc =
        [...lines].reverse().find((s) => s !== name && s !== "New") || "";
      return { name, isNew, desc };
    });
  });
}

const task = await taskSpace("dreamina-model-scraper");
console.log({ taskSpaceId: task.spaceId });

let page = (await task.pages()).find((p) => p.label === "p1");
if (!page) {
  const pages = await task.pages();
  page = pages[0] || (await task.newPage());
}

const result = {
  scrapedAt: new Date().toISOString(),
  sources: [],
};

for (const src of SOURCES) {
  try {
    await page.goto(src.url, { timeout: 60000 });
    await page.waitForLoadState();
    const models = (await extractModelList(page)).filter(
      (m) => src.type !== "image" || !EXCLUDED_IMAGE_MODELS.has(m.name)
    );
    result.sources.push({ ...src, models });
    console.log({ type: src.type, count: models.length });
  } catch (err) {
    result.sources.push({ ...src, models: [], error: String(err && err.message ? err.message : err) });
    console.error({ type: src.type, error: String(err && err.message ? err.message : err) });
  }
}

const okCount = result.sources.filter((s) => s.models && s.models.length > 0).length;
if (okCount === 0) {
  throw new Error("all sources failed to scrape");
}

const stamp = result.scrapedAt.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
await fs.mkdir(`${BASE}/snapshots`, { recursive: true });
await fs.writeFile(`${BASE}/models.json`, JSON.stringify(result, null, 2));
await fs.writeFile(
  `${BASE}/snapshots/snapshot-${stamp}.json`,
  JSON.stringify(result, null, 2)
);
console.log({ saved: true, scrapedAt: result.scrapedAt, okCount });
