// Copy chart modal logic
let templates = {};
let current = { templateKey: "men_bottoms", sizes: [], rows: [] };

const $ = (id) => document.getElementById(id);

function splitSizes(str) {
  return String(str || "")
    .split(/[, \t]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function parsePastedTable(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return null;

  const splitLine = (line) => {
    if (line.includes("\t")) return line.split("\t").map(s => s.trim());
    if (line.includes(",")) return line.split(",").map(s => s.trim());
    return line.split(/\s{2,}|\s+/).map(s => s.trim());
  };

  const head = splitLine(lines[0]);
  const sizes = head.slice(1);

  const rows = lines.slice(1).map(l => {
    const cells = splitLine(l);
    return { label: cells[0], values: cells.slice(1) };
  });

  return { sizes, rows };
}

/**
 * Remove any size column where ALL measurement values are blank.
 */
function pruneEmptySizeColumns(sizes, rows) {
  const keep = [];

  for (let ci = 0; ci < sizes.length; ci++) {
    const hasAny = rows.some(r => {
      const v = r?.values?.[ci];
      return v != null && String(v).trim() !== "";
    });
    if (hasAny) keep.push(ci);
  }

  // If everything is empty, keep original (avoid saving an empty chart accidentally)
  if (!keep.length) return { sizes, rows };

  const newSizes = keep.map(ci => sizes[ci]);
  const newRows = rows.map(r => ({
    ...r,
    values: keep.map(ci => (r.values && r.values[ci] != null ? r.values[ci] : ""))
  }));

  return { sizes: newSizes, rows: newRows };
}
/**
 * Round any numeric value to the nearest 0.25.
 * Keeps blanks as blanks, and non-numbers untouched.
 */
function roundToQuarter(value) {
  const s = String(value ?? "").trim();
  if (s === "") return "";

  const n = Number(s);
  if (!Number.isFinite(n)) return s;

  const rounded = Math.round(n * 4) / 4;

  // Format: remove trailing .00
  const out = rounded.toFixed(2).replace(/\.00$/, "");
  return out;
}
function renderGrid() {
  const sizes = current.sizes;
  const rows = current.rows;

  let html = '<div class="tableWrap"><table><thead><tr>';
  html += `<th>Tag Size</th>`;
  sizes.forEach(s => { html += `<th>${s}</th>`; });
  html += '</tr></thead><tbody>';

  rows.forEach((r, ri) => {
    html += `<tr><th>${r.label}</th>`;
    sizes.forEach((s, ci) => {
      const v = (r.values && r.values[ci] != null) ? r.values[ci] : "";
      html += `<td class="cell"><input data-ri="${ri}" data-ci="${ci}" value="${String(v).replace(/"/g,'&quot;')}" /></td>`;
    });
    html += `</tr>`;
  });

  html += '</tbody></table></div>';
  $("grid").innerHTML = html;

  $("grid").querySelectorAll("input").forEach(inp => {
  inp.addEventListener("input", (e) => {
    const ri = Number(e.target.dataset.ri);
    const ci = Number(e.target.dataset.ci);
    current.rows[ri].values[ci] = e.target.value;
  });

  inp.addEventListener("blur", (e) => {
    const ri = Number(e.target.dataset.ri);
    const ci = Number(e.target.dataset.ci);

    const rounded = roundToQuarter(e.target.value);
    e.target.value = rounded;
    current.rows[ri].values[ci] = rounded;
  });
});
}

async function loadTemplates() {
  const r = await fetch("/api/templates");
  templates = await r.json();

  const sel = $("template");
  sel.innerHTML = "";

  Object.entries(templates).forEach(([k, t]) => {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = t.label;
    sel.appendChild(opt);
  });

  sel.value = current.templateKey;
  applyTemplate(current.templateKey);
}

function applyTemplate(key) {
  current.templateKey = key;
  const t = templates[key];

  current.sizes = t.sizes.slice();
  current.rows = t.rows.map(label => ({
    label,
    values: Array(current.sizes.length).fill("")
  }));

  renderGrid();
}

$("template").addEventListener("change", (e) => {
  applyTemplate(e.target.value);
  $("sizes").value = "";
  $("paste").value = "";
});

$("parseBtn").addEventListener("click", () => {
  const parsed = parsePastedTable($("paste").value);
  if (!parsed) return;

  current.sizes = parsed.sizes.length ? parsed.sizes : current.sizes;
  current.rows = parsed.rows.map(r => ({
    label: r.label,
    values: r.values
  }));

  // Prune empty size columns after paste
  const pruned = pruneEmptySizeColumns(current.sizes, current.rows);
  current.sizes = pruned.sizes;
  current.rows = pruned.rows;

  renderGrid();
});

$("sizes").addEventListener("change", () => {
  const s = splitSizes($("sizes").value);
  if (!s.length) return;

  current.sizes = s;

  current.rows = current.rows.map(r => {
    const v = Array.isArray(r.values) ? r.values.slice(0, s.length) : [];
    while (v.length < s.length) v.push("");
    return { ...r, values: v };
  });

  // Prune empty columns if user pasted a size list with empty columns
  const pruned = pruneEmptySizeColumns(current.sizes, current.rows);
  current.sizes = pruned.sizes;
  current.rows = pruned.rows;

  renderGrid();
});

$("saveBtn").addEventListener("click", async () => {
  $("status").textContent = "Saving...";

  const pruned = pruneEmptySizeColumns(current.sizes, current.rows);
  current.sizes = pruned.sizes;
  current.rows = pruned.rows;

  const payload = {
    skuTag: $("skuTag").value,
    templateKey: current.templateKey,
    chartName: $("chartName").value,
    direction: templates[current.templateKey]?.direction || "row",
    sizes: current.sizes,
    rows: current.rows,
    footer: $("footer").value,
  };

  const res = await fetch("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json.ok) {
    $("status").textContent = json.error || "Error";
    return;
  }

  $("status").textContent = `Saved. Linked to ${json.linkedProducts} product(s).`;
});
function getQueryParam(name){
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}
async function loadExistingChartIfAny(){
  const chartId = getQueryParam("chartId");
  const sku = getQueryParam("sku");
  if (!chartId && !sku) return;

  const url = chartId
    ? ("/api/chart?id=" + encodeURIComponent(chartId))
    : ("/api/chart?sku=" + encodeURIComponent(sku));

  if (sku) {
    const core = String(sku).replace(/^__+/, "").replace(/^_+/, "");
    const skuInput = $("skuTag");
    if (skuInput) skuInput.value = core;
  }

  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json.ok) {
    $("status").textContent = json.error || "Could not load chart";
    return;
  }
// Auto-fill SKU tag from the loaded chart (works for chartId + sku flows)
if (json.skuTag) {
  const coreFromChart = String(json.skuTag).replace(/^__+/, "").replace(/^_+/, "");
  const skuInput = $("skuTag");
  if (skuInput) skuInput.value = coreFromChart;
}

  let columns = [];
  let rows = [];
  try { columns = JSON.parse(json.columns_json || "[]"); } catch(e) {}
  try { rows = JSON.parse(json.rows_json || "[]"); } catch(e) {}

  const sizes = (columns || []).slice(1);
  const gridRows = (rows || []).map(r => ({
    label: r.label,
    values: Array.isArray(r.values) ? r.values : []
  }));

  current.sizes = sizes;
  current.rows = gridRows;

  if ($("chartName")) $("chartName").value = json.chartName || "";
  if ($("footer")) $("footer").value = json.footer || "";

renderGrid();
$("status").textContent = "Loaded existing chart.";
}

async function init(){
  await loadTemplates();
  await loadExistingChartIfAny();
}

init();

// =========================
// Copy JSON button
// =========================
(function(){
  const btn = document.getElementById("copyJsonBtn");
  const status = document.getElementById("copyJsonStatus");
  if (!btn) return;

function buildJsonPayload(){

  const cols = ["Tag Size", ...current.sizes];

  const lines = [];
  lines.push(cols.join("\t"));

  current.rows.forEach(r=>{
    const row = [r.label, ...(r.values || [])];
    lines.push(row.join("\t"));
  });

  return lines.join("\n");
}
  async function copyText(text){
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  btn.addEventListener("click", async () => {
    try{
const text = buildJsonPayload();
await copyText(text);
      if (status) status.textContent = "Copied.";
      setTimeout(() => { if (status) status.textContent = ""; }, 1800);
    } catch(e){
      if (status) status.textContent = "Copy failed.";
    }
  });
})();

// =========================
// Copy Shopify HTML button
// =========================

(function () {
  const btn = document.getElementById("copyHtmlBtn");
  const status = document.getElementById("copyHtmlStatus");

  if (!btn) return;

  const SHOPIFY_ROW_LABELS = {
    "tag size": "TAGSIZE",
    "tagsize": "TAGSIZE",
    "waist": "WAIST",
    "hips": "HIPS",
    "hip": "HIPS",
    "front rise": "FRONTRISE",
    "frontrise": "FRONTRISE",
    "back rise": "BACKRISE",
    "backrise": "BACKRISE",
    "upper thigh": "THIGH",
    "thigh": "THIGH",
    "knee": "KNEE",
    "leg opening": "LEG OPENING",
    "legopening": "LEG OPENING",
    "inseam": "INSEAM"
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizeLabel(value) {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

    return (
      SHOPIFY_ROW_LABELS[normalized] ||
      String(value ?? "").trim().toUpperCase()
    );
  }

  function formatMeasurement(value) {
    const cleaned = String(value ?? "")
      .trim()
      .replace(/["”“]/g, "");

    if (!cleaned) return "";

    return `${cleaned}"`;
  }

  function buildShopifyHtml() {
    const sizes = Array.isArray(current.sizes)
      ? current.sizes
      : [];

    const measurementRows = Array.isArray(current.rows)
      ? current.rows
      : [];

    if (!sizes.length) {
      throw new Error("The chart has no tag sizes.");
    }

    if (!measurementRows.length) {
      throw new Error("The chart has no measurement rows.");
    }

    const columnCount = sizes.length + 1;
    const firstColumnWidth = 14;
    const sizeColumnWidth =
      (100 - firstColumnWidth) / sizes.length;

    const html = [];

    html.push('<table style="width: 100%;" width="575">');
    html.push("<tbody>");

    // First row: TAGSIZE plus all sizes
    html.push("<tr>");

    html.push(
      `<td style="width: ${firstColumnWidth.toFixed(4)}%;"><strong>TAGSIZE</strong></td>`
    );

    sizes.forEach(size => {
      html.push(
        `<td style="width: ${sizeColumnWidth.toFixed(4)}%;"><strong>${escapeHtml(size)}</strong></td>`
      );
    });

    html.push("</tr>");

    // Measurement rows: first column contains the words
    measurementRows.forEach(row => {
      const label = normalizeLabel(row.label);
      const values = Array.isArray(row.values)
        ? row.values
        : [];

      html.push("<tr>");

      html.push(
        `<td style="width: ${firstColumnWidth.toFixed(4)}%;">${escapeHtml(label)}</td>`
      );

      sizes.forEach((size, columnIndex) => {
        const value = values[columnIndex] ?? "";

        html.push(
          `<td style="width: ${sizeColumnWidth.toFixed(4)}%;">${escapeHtml(formatMeasurement(value))}</td>`
        );
      });

      html.push("</tr>");
    });

    html.push("</tbody>");
    html.push("</table>");

    return html.join("\n");
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";

    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }

  btn.addEventListener("click", async () => {
    try {
      const html = buildShopifyHtml();

      await copyText(html);

      if (status) {
        status.textContent = "Shopify HTML copied.";
      }

      setTimeout(() => {
        if (status) status.textContent = "";
      }, 1800);
    } catch (error) {
      console.error(error);

      if (status) {
        status.textContent =
          error instanceof Error
            ? error.message
            : "Could not create Shopify HTML.";
      }
    }
  });
})();
