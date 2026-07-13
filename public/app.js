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

function escapeShopifyHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeShopifyLabel(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  return SHOPIFY_ROW_LABELS[normalized] || String(value ?? "").trim().toUpperCase();
}

function formatShopifyMeasurement(value, isHeaderRow) {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/["”“]/g, "");

  if (!cleaned || isHeaderRow) {
    return cleaned;
  }

  return `${cleaned}"`;
}

/**
 * Attempts to read the editor grid as rows of input values.
 *
 * Expected grid structure:
 * - Each visual row contains input or select elements.
 * - First field is the measurement label.
 * - Remaining fields are sizes or measurements.
 *
 * Adjust the selectors here if your grid uses a more specific row class.
 */
function getChartRowsFromGrid() {
  const grid = document.getElementById("grid");

  if (!grid) {
    throw new Error("Chart grid was not found.");
  }

  const possibleRows = Array.from(
    grid.querySelectorAll("tr, .grid-row, .chart-row, [data-row]")
  );

  const rows = possibleRows
    .map(row => {
      const fields = Array.from(
        row.querySelectorAll("input, select, textarea")
      );

      return fields.map(field => field.value.trim());
    })
    .filter(row => row.length > 1);

  if (rows.length) {
    return rows;
  }

  /*
   * Fallback for grids constructed as a flat collection of inputs.
   * Set data-row and data-column attributes when rendering the grid
   * for the most reliable export.
   */
  const indexedFields = Array.from(
    grid.querySelectorAll("[data-row][data-column]")
  );

  if (!indexedFields.length) {
    throw new Error("No editable chart values were found.");
  }

  const rowMap = new Map();

  indexedFields.forEach(field => {
    const rowIndex = Number(field.dataset.row);
    const columnIndex = Number(field.dataset.column);

    if (!rowMap.has(rowIndex)) {
      rowMap.set(rowIndex, []);
    }

    rowMap.get(rowIndex)[columnIndex] = field.value.trim();
  });

  return Array.from(rowMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row);
}

function createShopifySizeChartHtml(rows) {
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error("The chart needs a tag-size row and at least one measurement row.");
  }

  const columnCount = Math.max(...rows.map(row => row.length));

  if (columnCount < 2) {
    throw new Error("The chart needs at least one size column.");
  }

  const normalizedRows = rows.map(row => {
    const padded = [...row];

    while (padded.length < columnCount) {
      padded.push("");
    }

    return padded;
  });

  /*
   * Use a wider first column for labels.
   * The remaining width is divided equally among all sizes.
   */
  const firstColumnWidth = 14;
  const measurementColumnWidth =
    (100 - firstColumnWidth) / (columnCount - 1);

  const html = [];

  html.push('<table style="width: 100%;" width="575">');
  html.push("<tbody>");

  normalizedRows.forEach((row, rowIndex) => {
    html.push("<tr>");

    row.forEach((cell, columnIndex) => {
      const width =
        columnIndex === 0
          ? firstColumnWidth
          : measurementColumnWidth;

      let content;

      if (columnIndex === 0) {
        content = normalizeShopifyLabel(cell);
      } else {
        content = formatShopifyMeasurement(cell, rowIndex === 0);
      }

      content = escapeShopifyHtml(content);

      if (rowIndex === 0) {
        content = `<strong>${content}</strong>`;
      }

      html.push(
        `<td style="width: ${width.toFixed(4)}%;">${content}</td>`
      );
    });

    html.push("</tr>");
  });

  html.push("</tbody>");
  html.push("</table>");

  return html.join("\n");
}

async function copyShopifyHtml() {
  const status = document.getElementById("copyHtmlStatus");

  try {
    const rows = getChartRowsFromGrid();
    const html = createShopifySizeChartHtml(rows);

    await navigator.clipboard.writeText(html);

    if (status) {
      status.textContent = "Shopify HTML copied.";
    }
  } catch (error) {
    console.error(error);

    if (status) {
      status.textContent =
        error instanceof Error
          ? error.message
          : "Could not create Shopify HTML.";
    }
  }
}

document
  .getElementById("copyHtmlBtn")
  ?.addEventListener("click", copyShopifyHtml);
