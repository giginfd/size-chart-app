const state = {
  products: [],
  loading: false
};

const elements = {
  rows: document.getElementById("productRows"),
  status: document.getElementById("statusText"),
  search: document.getElementById("searchInput"),
  statusFilter: document.getElementById("statusFilter"),
  groupFilter: document.getElementById("groupFilter"),
  refresh: document.getElementById("refreshBtn")
};

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[character]
  );
}

function productNumericId(gid) {
  return String(gid || "").split("/").pop();
}

function formatDate(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function getFilteredProducts() {
  const searchQuery = elements.search.value
    .trim()
    .toLowerCase();

  const selectedStatus =
    elements.statusFilter.value;

  const selectedGroup =
    elements.groupFilter.value;

  return state.products.filter((product) => {
    const matchesStatus =
      !selectedStatus ||
      product.status === selectedStatus;

    const productGroups = Array.isArray(product.productGroups)
      ? product.productGroups
      : [];

    let matchesGroup = true;

    if (selectedGroup === "UNTAGGED") {
      matchesGroup = productGroups.length === 0;
    } else if (selectedGroup) {
      matchesGroup = productGroups.includes(selectedGroup);
    }

    const searchableText = [
      product.title,
      product.handle,
      product.skuTag,
      ...(product.tags || [])
    ]
      .join(" ")
      .toLowerCase();

    const matchesSearch =
      !searchQuery ||
      searchableText.includes(searchQuery);

    return (
      matchesStatus &&
      matchesGroup &&
      matchesSearch
    );
  });
}
function render() {
  const products = getFilteredProducts();

  elements.status.textContent =
    `${products.length} product${
      products.length === 1 ? "" : "s"
    } missing a size chart`;

  if (!products.length) {
    elements.rows.innerHTML = `
      <tr>
        <td colspan="6" class="missing-charts-empty">
  No products match the selected filters.
</td>
      </tr>
    `;

    return;
  }

  elements.rows.innerHTML = products
    .map((product) => {
      const productId = productNumericId(product.id);

      const shopifyUrl =
        `https://admin.shopify.com/store/tate-yoko-2/products/${productId}`;

      const sku = String(product.skuTag || "")
        .replace(/^__+/, "");

      const editorUrl = sku
        ? `/index.html?sku=${encodeURIComponent(sku)}`
        : "/index.html";

      return `
        <tr>
          <td>
            <strong>${escapeHtml(product.title)}</strong>
          </td>

         <td>
  <span class="status-badge status-badge--${String(product.status || "").toLowerCase()}">
    ${escapeHtml(product.status)}
  </span>
</td>

          <td>
            ${escapeHtml(product.skuTag || "No SKU tag")}
          </td>

          <td>
            ${escapeHtml(product.handle)}
          </td>

          <td>
            ${escapeHtml(formatDate(product.updatedAt))}
          </td>

          <td>
            <div class="nfd-row-actions">
              <a
                class="nfd-btn nfd-btn--small"
                href="${escapeHtml(editorUrl)}"
                target="_blank"
                rel="noopener"
              >
                Create Chart
              </a>

              <a
                class="nfd-btn nfd-btn--ghost nfd-btn--small"
                href="${escapeHtml(shopifyUrl)}"
                target="_blank"
                rel="noopener"
              >
                Shopify
              </a>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

async function fetchAllMissingProducts() {
  if (state.loading) return;

  state.loading = true;
  state.products = [];

  elements.rows.innerHTML = "";
  elements.status.textContent = "Loading products…";
  elements.refresh.disabled = true;

  try {
    let cursor = null;
    let hasNextPage = true;
    let page = 0;

    const seen = new Set();

    while (hasNextPage) {
      page += 1;

      elements.status.textContent =
        `Loading products… page ${page}`;

      const url = cursor
        ? `/api/audit?cursor=${encodeURIComponent(cursor)}`
        : "/api/audit";

      const response = await fetch(url, {
        cache: "no-store"
      });

      const json = await response
        .json()
        .catch(() => ({}));

      if (!response.ok || !json.ok) {
        throw new Error(
          json.error || "Could not load the product audit."
        );
      }

      const items = Array.isArray(json.items)
        ? json.items
        : [];

      for (const product of items) {
        const key = product.id || product.handle;

        if (seen.has(key)) continue;

        seen.add(key);
        state.products.push(product);
      }

      cursor = json.nextCursor || null;

      hasNextPage =
        Boolean(json.hasNextPage) &&
        Boolean(cursor);
    }

    state.products.sort((a, b) => {
      const aDate = new Date(a.updatedAt || 0);
      const bDate = new Date(b.updatedAt || 0);

      return bDate - aDate;
    });

    render();
  } catch (error) {
    console.error(error);

    elements.status.textContent =
      error instanceof Error
        ? error.message
        : "Could not load the product audit.";
  } finally {
    state.loading = false;
    elements.refresh.disabled = false;
  }
}

elements.search.addEventListener("input", render);
elements.statusFilter.addEventListener("change", render);
elements.groupFilter.addEventListener("change", render);
elements.refresh.addEventListener(
  "click",
  fetchAllMissingProducts
);

fetchAllMissingProducts();
