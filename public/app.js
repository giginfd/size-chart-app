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

  // Prune empty size columns right before saving
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

  if (!res.ok) {
    $("status").textContent = json.error || "Error";
    return;
  }  $("status").textContent =
    `Saved. Linked to ${json.linkedProducts} product(s).`;
});

function getQueryParam(name){
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}

async function loadExistingChartIfAny(){
  const sku = getQueryParam("sku");
  if (!sku) return;

  // Fill SKU input (UI shows __ prefix separately, so store only the core digits)
  const core = String(sku).replace(/^__+/, "");
  const skuInput = $("skuTag");
  if (skuInput) skuInput.value = core;

  const res = await fetch("/api/chart?sku=" + encodeURIComponent(sku));
  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json.ok) {
    $("status").textContent = json.error || "Could not load chart";
    return;
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
