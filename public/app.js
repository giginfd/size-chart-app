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
async function loadExistingChartIfAny() {
  const chartId = getQueryParam("chartId");
  const sku = getQueryParam("sku");
  const chartName = getQueryParam("chartName");
  const mode = getQueryParam("mode");

  // Prefill SKU from the product link.
  if (sku) {
    const core = String(sku)
      .replace(/^_+/, "")
      .trim();

    const skuInput = $("skuTag");

    if (skuInput) {
      skuInput.value = core;
    }
  }

  // Prefill chart name from the Shopify product title.
  if (chartName) {
    const chartNameInput = $("chartName");

    if (chartNameInput) {
      chartNameInput.value = chartName;
    }
  }

  /*
   * A Create Chart link should not search for or load
   * an existing chart. This prevents another chart from
   * overwriting the supplied SKU and product name.
   */
  if (mode === "create") {
    $("status").textContent =
      "New chart ready. Add the measurements and save.";
    return;
  }

  if (!chartId && !sku) return;

  const url = chartId
    ? "/api/chart?id=" + encodeURIComponent(chartId)
    : "/api/chart?sku=" + encodeURIComponent(sku);

  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json.ok) {
    $("status").textContent =
      json.error || "Could not load chart";
    return;
  }

  // Fill SKU from an existing chart.
  if (json.skuTag) {
    const coreFromChart = String(json.skuTag)
      .replace(/^_+/, "")
      .trim();

    const skuInput = $("skuTag");

    if (skuInput) {
      skuInput.value = coreFromChart;
    }
  }

  let columns = [];
  let rows = [];

  try {
    columns = JSON.parse(json.columns_json || "[]");
  } catch (error) {
    console.error("Could not parse chart columns:", error);
  }

  try {
    rows = JSON.parse(json.rows_json || "[]");
  } catch (error) {
    console.error("Could not parse chart rows:", error);
  }

  const sizes = columns.slice(1);

  const gridRows = rows.map((row) => ({
    label: row.label,
    values: Array.isArray(row.values)
      ? row.values
      : []
  }));

  current.sizes = sizes;
  current.rows = gridRows;

  if ($("chartName")) {
    $("chartName").value =
      json.chartName || chartName || "";
  }

  if ($("footer")) {
    $("footer").value = json.footer || "";
  }

  renderGrid();

  $("status").textContent =
    "Loaded existing chart.";
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

// ==========================================
// PRODUCT SEARCH
// ==========================================

const productSearchInput =
  document.getElementById("productSearch");

const productSearchResults =
  document.getElementById(
    "productSearchResults"
  );

const productSearchLoading =
  document.getElementById(
    "productSearchLoading"
  );

const selectedProduct =
  document.getElementById("selectedProduct");

const skuTagInput =
  document.getElementById("skuTag");

const chartNameInput =
  document.getElementById("chartName");

let productSearchTimer = null;
let productSearchController = null;
let currentProductResults = [];
let activeProductResultIndex = -1;

/*
 * Tracks values that were automatically assigned.
 * This prevents a later product selection from
 * accidentally overwriting something the user
 * manually typed.
 */
let autoFilledSkuValue = "";
let autoFilledChartName = "";

function escapeProductSearchHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getSkuTagCore(skuTag) {
  return String(skuTag || "")
    .trim()
    .replace(/^__+/, "");
}

function getSuggestedChartName(product) {
  /*
   * Use the full product title by default.
   *
   * Change this function later if you want
   * chart names to use only the fit name.
   */
  return String(product?.title || "").trim();
}

function canAutoFillInput(
  input,
  previousAutoValue
) {
  const current = String(input.value || "").trim();

  return (
    !current ||
    current === previousAutoValue
  );
}

function closeProductSearchResults() {
  productSearchResults.hidden = true;
  productSearchResults.innerHTML = "";
  productSearchInput.setAttribute(
    "aria-expanded",
    "false"
  );

  currentProductResults = [];
  activeProductResultIndex = -1;
}

function setProductSearchLoading(isLoading) {
  productSearchLoading.hidden = !isLoading;
}

function setActiveProductResult(index) {
  const options =
    productSearchResults.querySelectorAll(
      ".productSearchResult"
    );

  if (!options.length) return;

  activeProductResultIndex = Math.max(
    0,
    Math.min(index, options.length - 1)
  );

  options.forEach((option, optionIndex) => {
    const isActive =
      optionIndex === activeProductResultIndex;

    option.classList.toggle(
      "is-active",
      isActive
    );

    option.setAttribute(
      "aria-selected",
      isActive ? "true" : "false"
    );

    if (isActive) {
      option.scrollIntoView({
        block: "nearest"
      });
    }
  });
}

function renderProductSearchResults(items) {
  currentProductResults =
    Array.isArray(items) ? items : [];

  activeProductResultIndex = -1;

  if (!currentProductResults.length) {
    productSearchResults.innerHTML = `
      <div class="productSearchEmpty">
        No matching products found.
      </div>
    `;

    productSearchResults.hidden = false;

    productSearchInput.setAttribute(
      "aria-expanded",
      "true"
    );

    return;
  }

  productSearchResults.innerHTML =
    currentProductResults
      .map((product, index) => {
        const skuTag =
          product.skuTag ||
          "No valid __SKU tag";

        const matchedSku =
          product.matchedVariantSku
            ? `
              <span class="productSearchResult__variant">
                Variant SKU:
                ${escapeProductSearchHtml(
                  product.matchedVariantSku
                )}
              </span>
            `
            : "";

        const chartStatus =
          product.hasSizeChart
            ? `
              <span
                class="
                  productSearchResult__status
                  productSearchResult__status--has-chart
                "
              >
                Size chart assigned
              </span>
            `
            : `
              <span
                class="
                  productSearchResult__status
                  productSearchResult__status--missing
                "
              >
                No size chart
              </span>
            `;

        const image = product.imageUrl
          ? `
            <img
              class="productSearchResult__image"
              src="${escapeProductSearchHtml(
                product.imageUrl
              )}"
              alt=""
              loading="lazy"
            >
          `
          : `
            <div
              class="
                productSearchResult__image
                productSearchResult__image--empty
              "
            ></div>
          `;

        return `
          <button
            type="button"
            class="productSearchResult"
            role="option"
            aria-selected="false"
            data-product-index="${index}"
          >
            ${image}

            <span class="productSearchResult__body">
              <span class="productSearchResult__title">
                ${escapeProductSearchHtml(
                  product.title
                )}
              </span>

              <span class="productSearchResult__meta">
                ${escapeProductSearchHtml(
                  skuTag
                )}

                <span aria-hidden="true">·</span>

                ${escapeProductSearchHtml(
                  product.status
                )}
              </span>

              ${matchedSku}
            </span>

            ${chartStatus}
          </button>
        `;
      })
      .join("");

  productSearchResults.hidden = false;

  productSearchInput.setAttribute(
    "aria-expanded",
    "true"
  );
}

function renderSelectedProduct(product) {
  const skuTag =
    product.skuTag ||
    "No valid __SKU tag";

  const chartMessage =
    product.hasSizeChart
      ? `
        <div
          class="
            selectedProduct__notice
            selectedProduct__notice--warning
          "
        >
          This product already has a size chart${
            product.chartName
              ? `: <strong>${escapeProductSearchHtml(
                  product.chartName
                )}</strong>`
              : "."
          }
        </div>
      `
      : `
        <div
          class="
            selectedProduct__notice
            selectedProduct__notice--success
          "
        >
          This product does not currently have
          a size chart.
        </div>
      `;

  selectedProduct.innerHTML = `
    <div class="selectedProduct__card">
      ${
        product.imageUrl
          ? `
            <img
              class="selectedProduct__image"
              src="${escapeProductSearchHtml(
                product.imageUrl
              )}"
              alt=""
            >
          `
          : ""
      }

      <div class="selectedProduct__body">
        <div class="selectedProduct__title">
          ${escapeProductSearchHtml(
            product.title
          )}
        </div>

        <div class="selectedProduct__meta">
          ${escapeProductSearchHtml(
            skuTag
          )}

          <span aria-hidden="true">·</span>

          ${escapeProductSearchHtml(
            product.status
          )}
        </div>

        ${chartMessage}
      </div>

      <button
        type="button"
        class="selectedProduct__clear"
        id="clearSelectedProduct"
      >
        Change
      </button>
    </div>
  `;

  selectedProduct.hidden = false;

  document
    .getElementById("clearSelectedProduct")
    ?.addEventListener("click", () => {
      selectedProduct.hidden = true;
      selectedProduct.innerHTML = "";

      productSearchInput.value = "";
      productSearchInput.focus();
    });
}

function selectProduct(product) {
  if (!product) return;

  const skuCore =
    getSkuTagCore(product.skuTag);

  const suggestedChartName =
    getSuggestedChartName(product);

  if (
    skuCore &&
    canAutoFillInput(
      skuTagInput,
      autoFilledSkuValue
    )
  ) {
    skuTagInput.value = skuCore;
    autoFilledSkuValue = skuCore;

    skuTagInput.dispatchEvent(
      new Event("input", {
        bubbles: true
      })
    );
  }

  if (
    suggestedChartName &&
    canAutoFillInput(
      chartNameInput,
      autoFilledChartName
    )
  ) {
    chartNameInput.value =
      suggestedChartName;

    autoFilledChartName =
      suggestedChartName;

    chartNameInput.dispatchEvent(
      new Event("input", {
        bubbles: true
      })
    );
  }

  productSearchInput.value =
    product.title;

  renderSelectedProduct(product);
  closeProductSearchResults();
}

async function searchProducts(searchTerm) {
  if (productSearchController) {
    productSearchController.abort();
  }

  productSearchController =
    new AbortController();

  setProductSearchLoading(true);

  try {
    const response = await fetch(
      `/api/products/search?q=${encodeURIComponent(
        searchTerm
      )}`,
      {
        signal:
          productSearchController.signal
      }
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(
        data.error ||
        "Could not search products."
      );
    }

    renderProductSearchResults(
      data.items || []
    );
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }

    productSearchResults.innerHTML = `
      <div class="productSearchEmpty">
        ${escapeProductSearchHtml(
          error.message ||
          "Could not search products."
        )}
      </div>
    `;

    productSearchResults.hidden = false;
  } finally {
    setProductSearchLoading(false);
  }
}

productSearchInput?.addEventListener(
  "input",
  () => {
    const searchTerm =
      productSearchInput.value.trim();

    clearTimeout(productSearchTimer);

    if (searchTerm.length < 2) {
      closeProductSearchResults();
      setProductSearchLoading(false);
      return;
    }

    productSearchTimer = setTimeout(
      () => {
        searchProducts(searchTerm);
      },
      300
    );
  }
);

productSearchInput?.addEventListener(
  "keydown",
  (event) => {
    if (productSearchResults.hidden) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();

      setActiveProductResult(
        activeProductResultIndex + 1
      );
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();

      setActiveProductResult(
        activeProductResultIndex <= 0
          ? currentProductResults.length - 1
          : activeProductResultIndex - 1
      );
    }

    if (
      event.key === "Enter" &&
      activeProductResultIndex >= 0
    ) {
      event.preventDefault();

      selectProduct(
        currentProductResults[
          activeProductResultIndex
        ]
      );
    }

    if (event.key === "Escape") {
      closeProductSearchResults();
    }
  }
);

productSearchResults?.addEventListener(
  "click",
  (event) => {
    const resultButton =
      event.target.closest(
        "[data-product-index]"
      );

    if (!resultButton) return;

    const index = Number(
      resultButton.dataset.productIndex
    );

    selectProduct(
      currentProductResults[index]
    );
  }
);

document.addEventListener(
  "click",
  (event) => {
    const container =
      document.getElementById(
        "productSearchContainer"
      );

    if (
      container &&
      !container.contains(event.target)
    ) {
      closeProductSearchResults();
    }
  }
);

/*
 * Once the user manually changes either field,
 * it should no longer be treated as an
 * automatically populated value.
 */
skuTagInput?.addEventListener(
  "input",
  () => {
    if (
      skuTagInput.value !==
      autoFilledSkuValue
    ) {
      autoFilledSkuValue = "";
    }
  }
);

chartNameInput?.addEventListener(
  "input",
  () => {
    if (
      chartNameInput.value !==
      autoFilledChartName
    ) {
      autoFilledChartName = "";
    }
  }
);
