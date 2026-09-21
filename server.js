import express from "express";
import Parser from "rss-parser";
import * as cheerio from "cheerio";
import fs from "node:fs/promises";

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
  return s.replace(/\s+/g, " ").trim();
}

async function fetchArticle(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "ALIFO-AI-Article-Editor/1.0" }
  });
  if (!res.ok) throw new Error(`URL取得失敗: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr("content") ||
    $("title").text() ||
    $("h1").first().text();

  const image =
    $('meta[property="og:image"]').attr("content") ||
    $("article img").first().attr("src") ||
    $("main img").first().attr("src");

  const paragraphs = $("article p, main p, p")
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter(x => x.length > 20)
    .slice(0, 80);

  return {
    url,
    title: cleanText(title),
    image: image ? new URL(image, url).href : "",
    text: paragraphs.join("\n")
  };
}

async function generateWithAI(source) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return {
      title: source.title || "AI記事ドラフト",
      body:
        `【参考情報】\n${source.text.slice(0, 3500)}\n\n` +
        `※ OPENAI_API_KEYを設定すると、ALIFO AIがこの情報をもとに記事本文を自動生成します。`,
      summary: source.text.slice(0, 180),
      image: source.image
    };
  }

  const model = process.env.OPENAI_MODEL || "gpt-5.6-mini";
  const prompt = `あなたはALIFO AIの記事編集部です。
以下のWebページ情報だけを根拠に、日本語のニュース・解説記事の下書きを作成してください。
事実と推測を混同せず、元ページにない情報を作らないでください。
出力はJSONのみ:
{"title":"タイトル","summary":"120字以内の要約","body":"本文（見出しを含む）"}

元ページタイトル:
${source.title}

URL:
${source.url}

本文:
${source.text.slice(0, 12000)}`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    })
  });
  if (!r.ok) throw new Error(`AI生成失敗: ${r.status}`);
  const j = await r.json();
  const raw = j.choices?.[0]?.message?.content || "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AIのJSON応答を解析できませんでした");
  const out = JSON.parse(match[0]);
  return { ...out, image: source.image };
}

app.get("/api/queue", async (_req, res) => {
  const data = await loadData();
  res.json(data.queue);
});

app.post("/api/generate", async (req, res) => {
  try {
    if (!req.body?.url) return res.status(400).json({ error: "URLが必要です" });
    const source = await fetchArticle(req.body.url);
    const article = await generateWithAI(source);
    const data = await loadData();
    const item = {
      id: crypto.randomUUID(),
      status: "review",
      createdAt: new Date().toISOString(),
      source,
      ...article
    };
    data.queue.unshift(item);
    await saveData(data);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
      const source = await fetchArticle(item.link);
      const article = await generateWithAI(source);
      const row = {
        id: crypto.randomUUID(),
        status: "review",
        createdAt: new Date().toISOString(),
        source,
        ...article
      };
      data.queue.unshift(row);
      added.push(row);
    }

    await saveData(data);
    res.json({ count: added.length, items: added });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  }
  if (req.body.action === "reject") item.status = "rejected";

  await saveData(data);
  res.json(item);
});

app.post("/api/cron", async (req, res) => {
  if (process.env.CRON_SECRET && req.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const data = await loadData();
  const results = [];
  for (const s of data.sources) {
    try {
      const feed = await parser.parseURL(s.url);
      for (const item of (feed.items || []).slice(0, 5)) {
        if (!item.link || data.queue.some(x => x.source?.url === item.link)) continue;
        const source = await fetchArticle(item.link);
        const article = await generateWithAI(source);
        data.queue.unshift({
          id: crypto.randomUUID(),
          status: "review",
          createdAt: new Date().toISOString(),
          source,
          ...article
        });
        results.push(item.link);
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

app.listen(PORT, () => console.log(`ALIFO Article Editor listening on ${PORT}`));