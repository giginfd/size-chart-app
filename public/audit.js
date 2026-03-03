const $ = (id) => document.getElementById(id);

let ALL = [];

function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

function render(list){
  $("tbody").innerHTML = list.map(item => {
    const editUrl = `/?sku=${encodeURIComponent(item.skuTag || "")}`;
    return `
      <tr>
        <td>${esc(item.title)}</td>
        <td>${esc(item.handle)}</td>
        <td><code>${esc(item.skuTag)}</code></td>
        <td>${esc(item.chartName || "")}</td>
        <td style="text-align:right;">
          <a class="nfd-link" href="${editUrl}">Edit</a>
        </td>
      </tr>
    `;
  }).join("");

  $("status").textContent = `Showing ${list.length} item(s)`;
}

function applyFilter(){
  const q = $("q").value.trim().toLowerCase();
  if (!q) {
    render(ALL);
    return;
  }

  const filtered = ALL.filter(it =>
    (it.title || "").toLowerCase().includes(q) ||
    (it.handle || "").toLowerCase().includes(q) ||
    (it.skuTag || "").toLowerCase().includes(q) ||
    (it.chartName || "").toLowerCase().includes(q)
  );

  render(filtered);
}

async function init(){
  $("status").textContent = "Loading...";
  $("tbody").innerHTML = "";

  const res = await fetch("/api/audit");
  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json.ok) {
    $("status").textContent = json.error || "Error loading audit list";
    return;
  }

  ALL = json.items || [];
  $("status").textContent = `Loaded ${ALL.length} item(s).`;
  render(ALL);

  $("searchBtn").addEventListener("click", applyFilter);

  $("clearBtn").addEventListener("click", () => {
    $("q").value = "";
    render(ALL);
  });

  // Instant search as you type (nice UX)
  $("q").addEventListener("input", applyFilter);
}

init();
