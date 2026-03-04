const $ = (id) => document.getElementById(id);

let ALL = [];

function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

function fmtDate(iso){
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch(e){ return iso; }
}

function render(list){
  $("tbody").innerHTML = list.map(item => {
const editUrl = `/index.html?chartId=${encodeURIComponent(item.id)}`;
    const linked = (item.linkedCount == null) ? "" : String(item.linkedCount);
    const orphan = (item.isOrphan === true) ? "YES" : "";
    return `
      <tr>
        <td class="audit-col-sku"><code>${esc(item.skuTag || item.handle || "")}</code></td>
        <td class="audit-col-name">${esc(item.chartName || "")}</td>
        <td class="audit-col-dir">${esc(item.direction || "")}</td>
        <td class="audit-col-updated">${esc(fmtDate(item.updatedAt))}</td>
        <td class="audit-col-linked">${esc(linked)}</td>
        <td class="audit-col-orphan">${orphan}</td>
        <td class="audit-col-action"><a class="nfd-link" href="${editUrl}">Edit</a></td>
      </tr>
    `;
  }).join("");

  $("status").textContent = `Showing ${list.length} of ${ALL.length} chart(s)`;
}

function applyFilter(){
  const q = $("q").value.trim().toLowerCase();
  if (!q) return render(ALL);

  const filtered = ALL.filter(it =>
    (it.skuTag || "").toLowerCase().includes(q) ||
    (it.handle || "").toLowerCase().includes(q) ||
    (it.chartName || "").toLowerCase().includes(q)
  );

  render(filtered);
}

async function fetchAllCharts(limit = 1200){
  const seen = new Set();
  let all = [];
  let cursor = null;
  let hasNextPage = true;
  let page = 0;

  while (hasNextPage && all.length < limit) {
    page += 1;
    $("status").textContent = `Loading… ${all.length} loaded (page ${page})`;

    const url = cursor
      ? `/api/charts?includeUsage=1&cursor=${encodeURIComponent(cursor)}`
      : `/api/charts?includeUsage=1`;

    const res = await fetch(url, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));

    if (!res.ok || !json.ok) throw new Error(json.error || "Error loading charts");

    const items = Array.isArray(json.items) ? json.items : [];

    for (const it of items) {
      const key = it.id || `${it.handle}|${it.skuTag}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(it);
      if (all.length >= limit) break;
    }

    cursor = json.nextCursor || null;
    hasNextPage = !!json.hasNextPage && !!cursor;

    if (!items.length) break;
  }

  return all;
}

async function init(){
  try {
    $("status").textContent = "Loading…";
    $("tbody").innerHTML = "";

ALL = await fetchAllCharts(1200);

// Sort newest first
ALL.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

render(ALL);

    $("searchBtn").addEventListener("click", applyFilter);
    $("clearBtn").addEventListener("click", () => { $("q").value = ""; render(ALL); });
    $("q").addEventListener("input", applyFilter);
  } catch (e) {
    console.error(e);
    $("status").textContent = e.message || "Chart audit failed";
  }
}

init();
