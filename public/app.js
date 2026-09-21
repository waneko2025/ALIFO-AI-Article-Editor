async function api(url, options = {}) {
  const r = await fetch(url, {
    headers: {"Content-Type": "application/json"},
    ...options
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "エラーが発生しました");
  return j;
}

function esc(s = "") {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  }[c]));
}

function setBusy(button, busy, text) {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.original = button.textContent;
    button.textContent = text;
  } else if (button.dataset.original) {
    button.textContent = button.dataset.original;
  }
}

async function generate() {
  const input = document.querySelector("#url");
  const button = document.querySelector('button[onclick="generate()"]');
  const url = input.value.trim();

  if (!url) return alert("URLを入力してください");

  try {
    setBusy(button, true, "取得中…");
    await api("/api/generate", {
      method: "POST",
      body: JSON.stringify({url})
    });
    input.value = "";
    await loadAll();
    alert("記事を審査待ちボックスに追加しました");
  } catch (e) {
    alert(e.message);
  } finally {
    setBusy(button, false);
  }
}

async function addRss() {
  const input = document.querySelector("#rss");
  const button = document.querySelector('button[onclick="addRss()"]');
  const url = input.value.trim();

  if (!url) return alert("RSS URLを入力してください");

  try {
    setBusy(button, true, "登録中…");
    await api("/api/sources", {
      method: "POST",
      body: JSON.stringify({url})
    });
    input.value = "";
    await loadAll();
    alert("RSSを登録しました");
  } catch (e) {
    alert(e.message);
  } finally {
    setBusy(button, false);
  }
}

async function runRss() {
  const button = document.querySelector('button[onclick="runRss()"]');

  try {
    setBusy(button, true, "巡回中…");
    const j = await api("/api/cron", {method:"POST"});
    await loadAll();
    alert(`${j.added.filter(x => !String(x).startsWith("ERROR:")).length}件を取り込みました`);
  } catch (e) {
    alert(e.message);
  } finally {
    setBusy(button, false);
  }
}

async function loadSources() {
  const xs = await api("/api/sources");
  document.querySelector("#statSources").textContent = xs.length;
  document.querySelector("#sources").innerHTML = xs.length
    ? xs.map(x => `<div class="source"><span>●</span>${esc(x.url)}</div>`).join("")
    : "<div class='muted'>RSSはまだ登録されていません。</div>";
}

async function save(id, action) {
  const card = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!card) return;

  const body = card.querySelector(".body").value;
  const title = card.querySelector(".title").value;
  const summary = card.querySelector(".summary").value;

  try {
    await api(`/api/queue/${encodeURIComponent(id)}`, {
      method:"PATCH",
      body:JSON.stringify({title, summary, body, action})
    });
    await loadAll();
  } catch (e) {
    alert(e.message);
  }
}

async function loadQueue() {
  const xs = await api("/api/queue");
  const review = xs.filter(x => x.status === "review");

  document.querySelector("#statReview").textContent = review.length;
  document.querySelector("#queue").innerHTML = review.length
    ? review.map(x => `
      <article class="card" data-id="${esc(x.id)}">
        <div class="card-top">
          <span class="review-badge">審査待ち</span>
          <span class="date">${new Date(x.createdAt).toLocaleString("ja-JP")}</span>
        </div>

        ${x.image ? `
          <img class="article-image" src="${esc(x.image)}" alt="" loading="lazy"
               onerror="this.style.display='none'">
        ` : ""}

        <div class="meta">
          参照元：
          <a href="${esc(x.source.url)}" target="_blank" rel="noreferrer">
            ${esc(x.source.title || x.source.url)}
          </a>
        </div>

        <label>タイトル</label>
        <input class="title" value="${esc(x.title)}">

        <label>要約</label>
        <textarea class="summary">${esc(x.summary || "")}</textarea>

        <label>本文</label>
        <textarea class="body">${esc(x.body || "")}</textarea>

        <div class="actions">
          <button onclick="save('${esc(x.id)}','approve')">✓ 承認</button>
          <button class="secondary" onclick="save('${esc(x.id)}','save')">保存</button>
          <button class="danger" onclick="save('${esc(x.id)}','reject')">却下</button>
        </div>
      </article>
    `).join("")
    : `<div class="empty">
         <div class="empty-icon">✓</div>
         <strong>審査待ちの記事はありません</strong>
         <p>URLを入力するか、RSSを巡回するとここに記事が入ります。</p>
       </div>`;
}

async function loadAll() {
  try {
    await Promise.all([loadQueue(), loadSources()]);
  } catch (e) {
    console.error(e);
  }
}

loadAll();
