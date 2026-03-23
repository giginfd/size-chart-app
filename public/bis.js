const $ = (s) => document.querySelector(s);

let ALL = [];
let SORT = { key: "waitingContactsCount", dir: "desc"};
let pollTimer = null;
let lastRunning = false;

function fmtDate(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString();
}

function fmtLastUpdated(ts) {
  if (!ts) return "Never";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "Never";
  return d.toLocaleString();
}

function escapeHtml(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}


function compareValues(a, b, key) {
  const av = a?.[key];
  const bv = b?.[key];

  if (["waitingContactsCount", "omnisendCount", "ampCount", "totalCount"].includes(key)) {
    return Number(av || 0) - Number(bv || 0);
  }

  if (key === "lastRequestedAt") {
    return new Date(av || 0).getTime() - new Date(bv || 0).getTime();
  }

  return String(av || "").localeCompare(String(bv || ""));
}
function sortItems(items) {
  const out = [...items].sort((a, b) => compareValues(a, b, SORT.key));
  if (SORT.dir === "desc") out.reverse();
  return out;
}

function row(item) {
  const url = item.url || "";
  return `
    <tr>
      <td>${escapeHtml(item.productTitle || "")}</td>
      <td>${escapeHtml(item.variantTitle || "")}</td>
<td>${escapeHtml(item.sku || "")}</td>
<td>${escapeHtml(item.omnisendCount ?? 0)}</td>
<td>${escapeHtml(item.ampCount ?? 0)}</td>
<td><strong>${escapeHtml(item.totalCount ?? 0)}</strong></td>
<td>${escapeHtml(fmtDate(item.lastRequestedAt || ""))}</td>
      <td>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">Open</a>` : ""}</td>
    </tr>
  `;
}
function updateSortButtons() {
  document.querySelectorAll(".sortBtn").forEach((btn) => {
    const key = btn.dataset.sort;
    const base = btn.dataset.label || btn.textContent.replace(/ ↑| ↓/, "").trim();

    btn.dataset.label = base;
    btn.classList.toggle("is-active", key === SORT.key);

    if (key === SORT.key) {
      btn.textContent = `${base}${SORT.dir === "asc" ? " ↑" : " ↓"}`;
    } else {
      btn.textContent = base;
    }
  });
}

function applyFilters() {
  const q = ($("#q").value || "").trim().toLowerCase();
  const minWaiting = Number($("#minWaiting").value || 0);
  const variantFilter = ($("#variantFilter").value || "").trim().toLowerCase();

  const filtered = ALL.filter((item) => {
    const hay = [
      item.productTitle,
      item.variantTitle,
      item.sku,
      item.productID,
      item.variantID,
      item.url
    ].join(" ").toLowerCase();
    const waiting = Number(item.waitingContactsCount || 0);
    const variant = String(item.variantTitle || "").toLowerCase();

    if (q && !hay.includes(q)) return false;
    if (waiting < minWaiting) return false;
    if (variantFilter && !variant.includes(variantFilter)) return false;

    return true;
  });

  const sorted = sortItems(filtered);
  $("#tbody").innerHTML = sorted.map(row).join("");
  $("#status").textContent = `${filtered.length} shown / ${ALL.length} total`;
updateSortButtons();
}

async function loadBisData() {
  const res = await fetch("/api/bis");
  const data = await res.json();

  if (!data.ok) {
    $("#status").textContent = "Failed to load BIS data";
    return;
  }

  ALL = Array.isArray(data.items) ? data.items : [];
  $("#lastUpdated").textContent = fmtLastUpdated(data.cacheAt);
  applyFilters();
}

async function loadBisStatus() {
  const res = await fetch("/api/bis/status");
  const data = await res.json();

  if (!data.ok) {
    $("#jobStatus").textContent = "Status unavailable";
    return;
  }

  const job = data.job || {};
  const running = !!job.running;

    $("#jobStatus").textContent =if (running) {
$("#bisHelper").textContent = "Refreshing BIS data in the background. Please wait.";    
$("#jobStatus").textContent =
      `Refreshing in background. Please wait. Passes ${job.passesDone || 0}/3 • Pages ${job.pagesDone || 0} • Rows ${job.rowsFound || 0}`;
    $("#refreshBtn").disabled = true;
    $("#refreshBtn").textContent = "Refreshing...";
  } else if (job.error) {
    $("#jobStatus").textContent = `Error: ${job.error}`;
    $("#refreshBtn").disabled = false;
    $("#refreshBtn").textContent = "Refresh BIS Data";
    $("#jobStatus").textContent = "No BIS cache yet. Click Refresh BIS Data to build it.";
  $("#refreshBtn").disabled = false;
  $("#refreshBtn").textContent = "Refresh BIS Data";
}
} else if ((data.cacheCount || 0) === 0) {
  $("#jobStatus").textContent = "Ready";
  $("#bisHelper").textContent = "No BIS data yet. Ask Gigi to refresh the data.";
  $("#refreshBtn").disabled = false;
  $("#refreshBtn").textContent = "Refresh BIS Data";
}
 else {
    $("#jobStatus").textContent = "Up to Date";
    $("#refreshBtn").disabled = false;
    $("#refreshBtn").textContent = "Refresh BIS Data";
  }

  $("#lastUpdated").textContent = fmtLastUpdated(data.cacheAt);

  if (lastRunning && !running) {
    await loadBisData();
  }

  lastRunning = running;
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadBisStatus, 2000);
}

async function refreshBisData() {
  $("#jobStatus").textContent = "Starting refresh. Please wait...";
  $("#refreshBtn").disabled = true;
  $("#refreshBtn").textContent = "Refreshing...";

  const res = await fetch("/api/bis/refresh", { method: "POST" });
  const data = await res.json();

  if (!data.ok) {
    $("#jobStatus").textContent = "Failed to start refresh";
    $("#refreshBtn").disabled = false;
    $("#refreshBtn").textContent = "Refresh BIS Data";
    return;
  }

  startPolling();
  await loadBisStatus();
}

$("#searchBtn").addEventListener("click", applyFilters);
$("#clearBtn").addEventListener("click", () => {
  $("#q").value = "";
  $("#minWaiting").value = "0";
  $("#variantFilter").value = "";
  applyFilters();
});

$("#q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyFilters();
});

document.querySelectorAll(".sortBtn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.sort;

    if (SORT.key === key) {
      SORT.dir = SORT.dir === "asc" ? "desc" : "asc";
      $("#jobStatus").textContent = "Ready"
$("#bisHelper").textContent = "";
;} else {
      SORT.key = key;
      SORT.dir = "asc";
    }

    applyFilters();
  });
});

$("#refreshBtn").addEventListener("click", refreshBisData);

loadBisData();
loadBisStatus();
startPolling();
