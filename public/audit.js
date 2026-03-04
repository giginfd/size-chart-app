const $ = (id) => document.getElementById(id);

let ALL = [];

function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

function fmtDate(iso){
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch(e){
    return iso;
  }
}

function render(list){
  $("tbody").innerHTML = list.map(item => {
const editUrl = `/index.html?sku=${encodeURIComponent(item.handle || item.skuTag || "")}`;
    return `
      <tr>
        <td><code>${esc(item.skuTag || item.handle || "")}</code></td>
        <td>${esc(item.chartName || "")}</td>
        <td>${esc(item.direction || "")}</td>
        <td>${esc(fmtDate(item.updatedAt))}</td>
        <td style="text-align:right;">
          <a class="nfd-link" href="${editUrl}">Edit</a>
        </td>
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

async function fetchAllCharts(limit = 2000){
  let all = [];
  let cursor = null;
  let hasNextPage = true;
  let page = 0;

  while (hasNextPage && all.length < limit) {
    page += 1;
    $("status").textContent = `Loading… ${all.length} loaded (page ${page})`;

    const url = cursor
      ? `/api/charts?cursor=${encodeURIComponent(cursor)}`
      : `/api/charts`;

    const res = await fetch(url, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));

    if (!res.ok || !json.ok) {
      throw new Error(json.error || "Error loading charts");
    }

    const items = Array.isArray(json.items) ? json.items : [];
    all = all.concat(items);

    cursor = json.nextCursor || null;
    hasNextPage = !!json.hasNextPage && !!cursor;

    if (!items.length) break;
  }

  return all.slice(0, limit);
}

async function init(){
  try {
    $("status").textContent = "Loading…";
    $("tbody").innerHTML = "";

    ALL = await fetchAllCharts(5000);
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
