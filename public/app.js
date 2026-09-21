async function api(url, options={}) {
  const r = await fetch(url, {headers: {"Content-Type":"application/json"}, ...options});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "エラー");
  return j;
}
function esc(s="") {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function generate() {
  const url = document.querySelector("#url").value.trim();
  if (!url) return alert("URLを入力してください");
  try {
    await api("/api/generate", {method:"POST", body:JSON.stringify({url})});
    document.querySelector("#url").value="";
    await loadQueue();
    alert("審査待ちボックスに追加しました");
  } catch(e) { alert(e.message); }
}
async function addRss() {
  const url = document.querySelector("#rss").value.trim();
  if (!url) return alert("RSS URLを入力してください");
  try {
    await api("/api/sources", {method:"POST", body:JSON.stringify({url})});
    document.querySelector("#rss").value="";
    loadSources();
  } catch(e) { alert(e.message); }
}
async function runRss() {
  try {
    const j = await api("/api/cron", {method:"POST"});
    await loadQueue();
    alert(`${j.added.length}件を取り込みました`);
  } catch(e) { alert(e.message); }
}
async function loadSources() {
  const xs = await api("/api/sources");
  document.querySelector("#sources").innerHTML = xs.length
    ? xs.map(x=>`<div class="source">● ${esc(x.url)}</div>`).join("")
    : "<div class='muted'>RSSはまだ登録されていません。</div>";
}
async function save(id, action) {
  const card = document.querySelector(`[data-id="${id}"]`);
  const body = card.querySelector(".body").value;
  const title = card.querySelector(".title").value;
  const summary = card.querySelector(".summary").value;
  try {
    await api(`/api/queue/${id}`, {method:"PATCH", body:JSON.stringify({title,summary,body,action})});
    loadQueue();
  } catch(e) { alert(e.message); }
}
async function loadQueue() {
  const xs = await api("/api/queue");
  const review = xs.filter(x=>x.status==="review");
  document.querySelector("#count").textContent = review.length;
  document.querySelector("#queue").innerHTML = review.length ? review.map(x=>`
    <article class="card" data-id="${esc(x.id)}">
      ${x.image ? `<img src="${esc(x.image)}" alt="">` : ""}
      <div class="meta">参照元: <a href="${esc(x.source.url)}" target="_blank" rel="noreferrer">${esc(x.source.title || x.source.url)}</a></div>
      <input class="title" value="${esc(x.title)}">
      <textarea class="summary">${esc(x.summary||"")}</textarea>
      <textarea class="body">${esc(x.body||"")}</textarea>
      <div class="actions">
        <button onclick="save('${esc(x.id)}','approve')">✓ 承認</button>
        <button class="danger" onclick="save('${esc(x.id)}','reject')">却下</button>
        <button class="secondary" onclick="save('${esc(x.id)}','save')">保存</button>
      </div>
    </article>`).join("") : "<div class='empty'>審査待ちの記事はありません。</div>";
}
loadQueue(); loadSources();