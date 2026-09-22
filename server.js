import express from "express";
import Parser from "rss-parser";
import * as cheerio from "cheerio";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = "./data.json";
const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; ALIFO-AI-Article-Editor/3.0)" }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

async function loadData() {
  try {
    const d = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    return {
      sources: Array.isArray(d.sources) ? d.sources : [],
      queue: Array.isArray(d.queue) ? d.queue : [],
      published: Array.isArray(d.published) ? d.published : []
    };
  } catch {
    return { sources: [], queue: [], published: [] };
  }
}
async function saveData(d) {
  await fs.writeFile(DATA_FILE, JSON.stringify(d, null, 2), "utf8");
}
function cleanText(s = "") {
  return String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}
function absoluteUrl(src, base) {
  try { return src ? new URL(src, base).href : ""; } catch { return ""; }
}
function badBlock(text) {
  const t = cleanText(text);
  if (!t || t.length < 20) return true;
  return /関連記事|関連ニュース|おすすめ記事|おすすめ|ランキング|ニュース一覧|最新ニュース|広告|スポンサー|PR記事|ログイン|会員登録|サイトマップ|プライバシーポリシー|利用規約|Copyright|Follow us/i.test(t);
}
function blockScore($el, text) {
  const tag = ($el[0]?.name || "").toLowerCase();
  const cls = String($el.attr("class") || "") + " " + String($el.attr("id") || "");
  const t = cleanText(text);
  let score = tag === "p" ? 5 : tag === "blockquote" ? 4 : tag.startsWith("h") ? 1 : 0;
  if (t.length >= 50) score += 3;
  if ((t.match(/[。！？]/g) || []).length >= 2) score += 2;
  if (/related|recommend|ranking|sidebar|footer|header|nav|menu|social|sns|share|advert|banner|pickup|latest|breadcrumb|comment|newsletter|cookie|popup/i.test(cls)) score -= 12;
  if (/^https?:\/\//i.test(t)) score -= 10;
  if (tag === "li" && t.length < 45) score -= 6;
  return score;
}

function extractJsonLdArticle($) {
  const candidates = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed]);
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const type = Array.isArray(item["@type"]) ? item["@type"].join(" ") : String(item["@type"] || "");
        if (/NewsArticle|Article|ReportageNewsArticle|BlogPosting/i.test(type) && item.articleBody) {
          candidates.push({
            headline: cleanText(item.headline || ""),
            image: Array.isArray(item.image) ? item.image[0] : (typeof item.image === "object" ? item.image?.url : item.image),
            articleBody: String(item.articleBody)
          });
        }
      }
    } catch {}
  });
  return candidates.sort((a,b) => b.articleBody.length - a.articleBody.length)[0] || null;
}

function looksLikeRelatedHeadline(text) {
  const t = cleanText(text);
  if (!t || t.length < 12 || t.length > 120) return false;

  // News-site related links are commonly short headline-like strings.
  // Real article paragraphs usually contain sentence punctuation.
  const hasSentencePunctuation = /[。！？]/.test(t);
  const hasSentenceEnding = /[。！？]$/.test(t);
  const hasQuote = /[「」『』]/.test(t);
  const hasUrl = /^https?:\/\//i.test(t);
  const hasEllipsis = /(\.\.\.|…|・・・)$/.test(t);

  if (hasUrl) return true;
  // Related-news links on Japanese news sites often end with an ellipsis.
  if (hasEllipsis) return true;
  if (!hasSentenceEnding && t.length <= 110) return true;
  if (!hasSentencePunctuation && hasQuote) return true;
  if (!hasSentencePunctuation && /^[^。！？]+$/.test(t)) return true;

  return false;
}

function looksLikeSponichiRelated(text) {
  const t = cleanText(text);
  if (!t) return false;

  // Sponichi related-story modules commonly include a date in brackets
  // and/or an ellipsis at the end of the headline.
  if (/[［\[]\s*20\d{2}年\d{1,2}月\d{1,2}日/.test(t)) return true;
  if (/(?:\.\.\.|…|・・・)$/.test(t)) return true;

  // Short headline-shaped blocks without sentence-ending punctuation.
  if (t.length <= 120 && !/[。！？]$/.test(t)) return true;

  return false;
}

function splitArticleBody(text) {
  return String(text)
    .replace(/\r/g, "")
    .split(/\n+/)
    .map(cleanText)
    .filter(p => p.length >= 20 && !badBlock(p));
}

function keepEditorialBody(paragraphs, sourceUrl = "") {
  const editorial = [];
  let headlineRun = 0;
  const isSponichi = /(?:^|\.)sponichi\.co\.jp$/i.test(new URL(sourceUrl).hostname);

  for (const p of paragraphs) {
    const related = isSponichi
      ? looksLikeSponichiRelated(p)
      : looksLikeRelatedHeadline(p);

    if (related) {
      headlineRun++;
      // For Sponichi, the first strong related-story block after the
      // article paragraphs is the boundary. Do not let later headlines
      // leak into the draft.
      if (isSponichi && editorial.length >= 2) break;
      if (editorial.length >= 3 && headlineRun >= 2) break;
      continue;
    }

    headlineRun = 0;
    editorial.push(p);

    if (editorial.length >= 40) break;
  }

  return editorial;
}

function extractArticle($, sourceUrl) {
  const jsonLd = extractJsonLdArticle($);

  const title = cleanText(
    jsonLd?.headline ||
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    $("article h1").first().text() ||
    $("main h1").first().text() ||
    $("h1").first().text() ||
    $("title").first().text() || "無題の記事"
  );

  let image = absoluteUrl(
    jsonLd?.image ||
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    $("article img").first().attr("src") ||
    $("main img").first().attr("src"),
    sourceUrl
  );

  // When the publisher exposes articleBody in JSON-LD, use that as the
  // authoritative body. This avoids menus, related stories and ranking
  // modules that are often nested inside the visible article container.
  if (jsonLd?.articleBody && jsonLd.articleBody.length > 100) {
    const paragraphs = splitArticleBody(jsonLd.articleBody);
    const editorial = keepEditorialBody(paragraphs, sourceUrl);
    if (editorial.length >= 2) {
      return { title, image, paragraphs: editorial };
    }
  }

  const selectors = [
    "article", ".article-body", ".article-content", ".post-content",
    ".entry-content", ".story-body", ".news-detail", ".news-article",
    ".article__body", ".articleDetail", "main", "[role='main']", ".article"
  ];

  let container = null;
  for (const selector of selectors) {
    const node = $(selector).first();
    if (node.length && cleanText(node.text()).length > 250) {
      container = node;
      break;
    }
  }
  if (!container) container = $("body");

  // Cut off common "related content" sections even when they are nested
  // inside the article element.
  container.find([
    "script","style","noscript","template","svg","iframe","nav","header","footer","form",
    ".related",".related-articles",".recommend",".recommendations",".ranking",".sidebar",
    ".breadcrumb",".breadcrumbs",".share",".social",".sns",".advert",".advertisement",
    ".ads",".banner",".pickup",".latest",".comments",".comment",".newsletter",".cookie",
    ".modal",".popup",".menu"
  ].join(",")).remove();

  container.find("h2,h3").each((_, el) => {
    const heading = cleanText($(el).text());
    if (/関連記事|関連ニュース|おすすめ|ランキング|最新ニュース|ピックアップ|こちらも/i.test(heading)) {
      $(el).nextAll().remove();
      $(el).remove();
    }
  });

  const raw = [];
  container.find("p,h2,h3,blockquote,li").each((_, el) => {
    const $el = $(el);
    const text = cleanText($el.text());
    if (badBlock(text)) return;

    const score = blockScore($el, text);
    if (score < 2) return;

    raw.push({ text, score, tag: el.name, headlineLike: looksLikeRelatedHeadline(text) });
  });

  const seen = new Set();
  const unique = [];
  for (const item of raw) {
    const key = item.text.replace(/[\s「」『』（）()【】]/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  const paragraphs = [];
  let weak = 0;
  let headlineRun = 0;

  for (const item of unique) {
    if (item.tag === "li") continue;

    if (item.headlineLike) {
      headlineRun++;
      const sponichi = /(?:^|\.)sponichi\.co\.jp$/i.test(new URL(sourceUrl).hostname);
      if (sponichi && paragraphs.length >= 2) break;
      if (paragraphs.length >= 3 && headlineRun >= 2) break;
      continue;
    }

    headlineRun = 0;

    if (item.score < 4) {
      weak++;
      if (weak >= 3 && paragraphs.length >= 4) break;
      continue;
    }

    weak = 0;
    paragraphs.push(item.text);

    if (paragraphs.length >= 35) break;
  }

  if (paragraphs.length < 3) {
    return { title, image, paragraphs: unique.slice(0, 20).map(x => x.text) };
  }
  return { title, image, paragraphs };
}

function cleanDraftBody(body, sourceUrl = "") {
  const text = String(body || "").replace(/\r/g, "");
  const isSponichi = (() => {
    try {
      return /(?:^|\.)sponichi\.co\.jp$/i.test(new URL(sourceUrl).hostname);
    } catch {
      return false;
    }
  })();

  if (!isSponichi) return text;

  const lines = text.split("\n");
  const out = [];
  let inDetail = false;
  let editorialLines = 0;
  let stoppedBeforeRelated = false;

  for (const line of lines) {
    const t = cleanText(line);

    if (t === "【詳細】") {
      inDetail = true;
      editorialLines = 0;
      out.push(line);
      continue;
    }

    if (t === "【出典】") {
      inDetail = false;
      out.push(line);
      continue;
    }

    if (inDetail && t) {
      const hasRelatedDate = /[［\[]\s*20\d{2}年\d{1,2}月\d{1,2}日/.test(t);
      const hasEllipsis = /(?:\.\.\.|…|・・・)$/.test(t);
      const headlineLike = looksLikeSponichiRelated(t);

      if (editorialLines >= 2 && (hasRelatedDate || hasEllipsis || headlineLike)) {
        stoppedBeforeRelated = true;
        inDetail = false;
        continue;
      }

      out.push(line);
      editorialLines++;
      continue;
    }

    out.push(line);
  }

  if (stoppedBeforeRelated && !out.some(line => cleanText(line) === "【出典】")) {
    out.push("", "【出典】", "", sourceUrl);
  }

  return out.join("\n");
}

function makeSummary(paragraphs, max = 220) {
  const text = paragraphs.slice(0, 3).join(" ");
  if (!text) return "本文を十分に取得できませんでした。内容を確認してください。";
  return text.length > max ? text.slice(0, max).replace(/[^。！？]*$/, "") + "…" : text;
}
function makeTitle(title) {
  return cleanText(title)
    .replace(/\s*[|｜]\s*[^|｜]+$/, "")
    .replace(/\s+-\s+[^-]+$/, "")
    .trim() || "Web記事ドラフト";
}
function makeBody(paragraphs, url) {
  const ps = paragraphs.filter(p => p.length >= 25).slice(0, 24);
  const out = ["【記事のポイント】", "", makeSummary(ps), "", "【詳細】", ""];
  for (const p of ps) out.push(p, "");
  out.push("【出典】", "", url);
  return out.join("\n").trim();
}

async function fetchArticle(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("http / https のURLだけ利用できます");
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ALIFO-AI-Article-Editor/3.0)" },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`URL取得失敗: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const finalUrl = res.url || url;
  const extracted = extractArticle($, finalUrl);
  if (extracted.paragraphs.length < 2) throw new Error("記事本文を十分に抽出できませんでした。別のURLを試してください。");
  return {
    url: finalUrl,
    title: makeTitle(extracted.title),
    image: extracted.image,
    text: extracted.paragraphs.join("\n")
  };
}
function newQueueItem(source) {
  const paragraphs = source.text.split("\n").map(cleanText).filter(Boolean);
  return {
    id: crypto.randomUUID(),
    status: "review",
    createdAt: new Date().toISOString(),
    source,
    title: source.title,
    summary: makeSummary(paragraphs),
    body: makeBody(paragraphs, source.url),
    image: source.image || ""
  };
}

app.get("/api/health", (_req,res) => res.json({ ok:true, name:"ALIFO AI Article Editor", aiApi:false }));
app.get("/api/queue", async (_req,res) => {
  const data = await loadData();
  let changed = false;
  for (const item of data.queue) {
    const cleaned = cleanDraftBody(item.body, item.source?.url || "");
    if (cleaned !== item.body) {
      item.body = cleaned;
      changed = true;
    }
  }
  if (changed) await saveData(data);
  res.json(data.queue);
});
app.get("/api/sources", async (_req,res) => res.json((await loadData()).sources));

app.post("/api/generate", async (req,res) => {
  try {
    if (!req.body?.url) return res.status(400).json({error:"URLが必要です"});
    const source = await fetchArticle(req.body.url);
    const data = await loadData();
    const item = newQueueItem(source);
    data.queue.unshift(item);
    await saveData(data);
    res.json(item);
  } catch (e) {
    res.status(500).json({error:e.message || "記事生成に失敗しました"});
  }
});

app.post("/api/sources", async (req,res) => {
  try {
    if (!req.body?.url) return res.status(400).json({error:"RSS URLが必要です"});
    const url = String(req.body.url).trim();
    await parser.parseURL(url);
    const data = await loadData();
    if (!data.sources.some(s => s.url === url)) data.sources.push({id:crypto.randomUUID(), url});
    await saveData(data);
    res.json(data.sources);
  } catch (e) {
    res.status(500).json({error:e.message || "RSS登録に失敗しました"});
  }
});

async function pollSource(source, data) {
  const feed = await parser.parseURL(source.url);
  let added = 0;
  for (const item of (feed.items || []).slice(0,10)) {
    if (!item.link) continue;
    if (data.queue.some(x => x.source?.url === item.link) || data.published.some(x => x.source?.url === item.link)) continue;
    try {
      const sourceData = await fetchArticle(item.link);
      data.queue.unshift(newQueueItem(sourceData));
      added++;
    } catch (e) {
      console.warn("RSS item skipped:", item.link, e.message);
    }
  }
  return added;
}

app.post("/api/cron", async (req,res) => {
  if (process.env.CRON_SECRET && req.get("x-cron-secret") !== process.env.CRON_SECRET) return res.status(401).json({error:"Unauthorized"});
  try {
    const data = await loadData();
    let added = 0;
    for (const source of data.sources) added += await pollSource(source, data);
    await saveData(data);
    res.json({added});
  } catch (e) {
    res.status(500).json({error:e.message || "RSS巡回に失敗しました"});
  }
});

app.patch("/api/queue/:id", async (req,res) => {
  const data = await loadData();
  const index = data.queue.findIndex(x => x.id === req.params.id);
  if (index < 0) return res.status(404).json({error:"記事がありません"});
  const item = data.queue[index];
  item.title = req.body.title ?? item.title;
  item.summary = req.body.summary ?? item.summary;
  item.body = cleanDraftBody(req.body.body ?? item.body, item.source?.url || "");
  if (req.body.action === "approve") {
    item.status = "approved";
    data.queue.splice(index,1);
    data.published.unshift(item);
  } else if (req.body.action === "reject") {
    item.status = "rejected";
    data.queue.splice(index,1);
  } else {
    item.status = "review";
  }
  item.updatedAt = new Date().toISOString();
  await saveData(data);
  res.json(item);
});

app.listen(PORT, () => console.log(`ALIFO Article Editor listening on ${PORT}`));
