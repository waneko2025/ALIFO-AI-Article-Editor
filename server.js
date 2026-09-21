import express from "express";
import Parser from "rss-parser";
import * as cheerio from "cheerio";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = "./data.json";
const parser = new Parser();

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

async function loadData() {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
  } catch {
    return { sources: [], queue: [], published: [] };
  }
}

async function saveData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function cleanText(s = "") {
  return String(s)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeImage(src, baseUrl) {
  if (!src) return "";
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return "";
  }
}

async function fetchArticle(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("http / https のURLだけ利用できます");
  }

  const res = await fetch(url, {
    headers: {
      "User-Agent": "ALIFO-AI-Article-Editor/2.0 (+article-editor)"
    },
    redirect: "follow"
  });

  if (!res.ok) throw new Error(`URL取得失敗: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  $("script,style,noscript,nav,footer,header,form,svg").remove();

  const title = cleanText(
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    $("h1").first().text() ||
    $("title").text() ||
    "無題の記事"
  );

  const image = normalizeImage(
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    $("article img").first().attr("src") ||
    $("main img").first().attr("src") ||
    $("img").first().attr("src"),
    url
  );

  const paragraphs = $("article p, main p, [role='main'] p, .article p, .post p, p")
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter(x => x.length >= 20)
    .filter((x, i, a) => a.indexOf(x) === i)
    .slice(0, 100);

  const text = paragraphs.join("\n");

  if (!text && !title) {
    throw new Error("ページから記事情報を取得できませんでした");
  }

  return { url, title, image, text };
}

/*
 * OpenAI等の外部AI APIを使わない記事編集エンジン。
 * 取得した本文を、重複除去・段落整理・要約・見出し化して
 * 「審査待ち」に入れます。
 */
function makeSummary(text, max = 150) {
  const s = cleanText(text);
  if (!s) return "本文を取得できませんでした。";
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/[、。！？]?[^\s、。！？]*$/, "") + "…";
}

function makeTitle(sourceTitle) {
  let t = cleanText(sourceTitle)
    .replace(/\s*[\|｜]\s*[^|｜]+$/, "")
    .replace(/\s*-\s*[^-]+$/, "")
    .trim();
  if (!t) t = "Web記事ドラフト";
  return t;
}

function makeBody(source) {
  const paragraphs = source.text
    .split("\n")
    .map(cleanText)
    .filter(Boolean)
    .slice(0, 60);

  const chunks = [];
  let current = [];

  for (const p of paragraphs) {
    current.push(p);
    if (current.join("").length >= 220) {
      chunks.push(current.join("\n\n"));
      current = [];
    }
  }
  if (current.length) chunks.push(current.join("\n\n"));

  const intro = makeSummary(source.text, 180);

  let body = `## この記事のポイント\n\n${intro}\n\n`;

  if (chunks.length) {
    body += `## 詳細\n\n`;
    body += chunks.join("\n\n");
  } else {
    body += source.text || "本文を取得できませんでした。";
  }

  body += `\n\n## 参照元\n\n${source.url}`;
  return body;
}

function generateArticle(source) {
  return {
    title: makeTitle(source.title),
    summary: makeSummary(source.text),
    body: makeBody(source),
    image: source.image
  };
}

function newQueueItem(source) {
  return {
    id: crypto.randomUUID(),
    status: "review",
    createdAt: new Date().toISOString(),
    source,
    ...generateArticle(source)
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "ALIFO AI Article Editor", aiApi: false });
});

app.get("/api/queue", async (_req, res) => {
  const data = await loadData();
  res.json(data.queue);
});

app.post("/api/generate", async (req, res) => {
  try {
    if (!req.body?.url) return res.status(400).json({ error: "URLが必要です" });
    const source = await fetchArticle(req.body.url);
    const item = newQueueItem(source);

    const data = await loadData();
    data.queue.unshift(item);
    await saveData(data);

    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message || "記事生成に失敗しました" });
  }
});

app.post("/api/rss", async (req, res) => {
  try {
    if (!req.body?.url) return res.status(400).json({ error: "RSS URLが必要です" });

    const feed = await parser.parseURL(req.body.url);
    const data = await loadData();
    const added = [];

    for (const item of (feed.items || []).slice(0, 10)) {
      if (!item.link) continue;
      if (data.queue.some(x => x.source?.url === item.link)) continue;

      try {
        const source = await fetchArticle(item.link);
        const row = newQueueItem(source);
        data.queue.unshift(row);
        added.push(row);
      } catch (e) {
        console.warn("RSS item skipped:", item.link, e.message);
      }
    }

    await saveData(data);
    res.json({ count: added.length, items: added });
  } catch (e) {
    res.status(500).json({ error: e.message || "RSS取得に失敗しました" });
  }
});

app.patch("/api/queue/:id", async (req, res) => {
  const data = await loadData();
  const item = data.queue.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: "記事がありません" });

  Object.assign(item, {
    title: req.body.title ?? item.title,
    summary: req.body.summary ?? item.summary,
    body: req.body.body ?? item.body
  });

  if (req.body.action === "approve") {
    item.status = "approved";
    data.published.unshift(item);
  } else if (req.body.action === "reject") {
    item.status = "rejected";
  } else if (req.body.action === "review") {
    item.status = "review";
  }

  await saveData(data);
  res.json(item);
});

app.post("/api/cron", async (req, res) => {
  if (
    process.env.CRON_SECRET &&
    req.get("x-cron-secret") !== process.env.CRON_SECRET
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const data = await loadData();
  const results = [];

  for (const s of data.sources) {
    try {
      const feed = await parser.parseURL(s.url);

      for (const item of (feed.items || []).slice(0, 5)) {
        if (!item.link || data.queue.some(x => x.source?.url === item.link)) continue;

        try {
          const source = await fetchArticle(item.link);
          data.queue.unshift(newQueueItem(source));
          results.push(item.link);
        } catch (e) {
          results.push(`ERROR: ${item.link} ${e.message}`);
        }
      }
    } catch (e) {
      results.push(`ERROR: ${s.url} ${e.message}`);
    }
  }

  await saveData(data);
  res.json({ added: results });
});

app.get("/api/sources", async (_req, res) => {
  const data = await loadData();
  res.json(data.sources);
});

app.post("/api/sources", async (req, res) => {
  if (!req.body?.url) return res.status(400).json({ error: "RSS URLが必要です" });

  const data = await loadData();
  if (!data.sources.some(s => s.url === req.body.url)) {
    data.sources.push({ id: crypto.randomUUID(), url: req.body.url });
    await saveData(data);
  }

  res.json(data.sources);
});

app.listen(PORT, () => {
  console.log(`ALIFO Article Editor listening on ${PORT}`);
});
