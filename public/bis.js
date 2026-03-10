const $ = (s) => document.querySelector(s);

let ALL = [];
let SORT = { key: "waitingContactsCount", dir: "desc" };
function fmtDate(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString();
}
function compareValues(a, b, key) {
  const av = a?.[key];
  const bv = b?.[key];

  if (key === "waitingContactsCount") {
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
function escapeHtml(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function row(item) {
  const url = item.url || "";
  return `
    <tr>
      <td>${escapeHtml(item.productTitle || "")}</td>
      <td>${escapeHtml(item.variantTitle || "")}</td>
      <td>${escapeHtml(item.sku || "")}</td>
      <td>${escapeHtml(item.waitingContactsCount ?? "")}</td>
      <td>${escapeHtml(fmtDate(item.lastRequestedAt || ""))}</td>
      <td>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">Open</a>` : ""}</td>
    </tr>
  `;
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
}

async function load() {
  $("#status").textContent = "Loading...";
  const res = await fetch("/api/bis");
  const data = await res.json();

  if (!data.ok) {
    $("#status").textContent = "Failed to load data";
    console.error(data);
    return;
  }

  ALL = Array.isArray(data.items) ? data.items : [];
  applyFilters();
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

load();

document.querySelectorAll(".sortBtn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.sort;

    if (SORT.key === key) {
      SORT.dir = SORT.dir === "asc" ? "desc" : "asc";
    } else {
      SORT.key = key;
      SORT.dir = "asc";
    }

    applyFilters();
  });
});
