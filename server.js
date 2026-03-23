require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { PDFParse } = require("pdf-parse");
const { parse } = require("csv-parse/sync");

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[.,()]/g, " ")
    .replace(/\b(DBA|LLC|LTD|INC|CORP|CORPORATION|SAS|COM)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const retailerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const CUSTOM_RETAILERS_FILE = path.join(__dirname, "data", "custom-retailers.json");

function loadCustomRetailers() {
  try {
    if (!fs.existsSync(CUSTOM_RETAILERS_FILE)) return [];
    const raw = fs.readFileSync(CUSTOM_RETAILERS_FILE, "utf8");
    return JSON.parse(raw || "[]");
  } catch (err) {
    return [];
  }
}

function saveCustomRetailers(items) {
  fs.writeFileSync(CUSTOM_RETAILERS_FILE, JSON.stringify(items, null, 2), "utf8");
}
const RETAILER_ALIASES_FILE = path.join(__dirname, "data", "retailer-aliases.json");

function loadSavedRetailerAliases() {
  try {
    if (!fs.existsSync(RETAILER_ALIASES_FILE)) return {};
    const raw = fs.readFileSync(RETAILER_ALIASES_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch (err) {
    return {};
  }
}
function saveRetailerAliases(map) {
  fs.writeFileSync(RETAILER_ALIASES_FILE, JSON.stringify(map, null, 2), "utf8");
}


const SHOP_DOMAIN = process.env.SHOP_DOMAIN;
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const API_VERSION = process.env.API_VERSION || "2025-01";
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, "public");

if (!SHOP_DOMAIN || !ADMIN_API_TOKEN) {
  console.error("Missing SHOP_DOMAIN or ADMIN_API_TOKEN in .env");
  process.exit(1);
}

const GQL_ENDPOINT = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

async function shopifyGraphQL(query, variables) {
  const res = await fetch(GQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)?.slice(0, 800)}`);
  if (json?.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 800)}`);
  return json.data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function parseSkuFromFilename(filename) {
  const m = String(filename || "").match(/^(\d+)/);
  return m ? m[1] : null;
}

function parseSuffixFromFilename(filename) {
  const m = String(filename || "").match(/_(\w+)\.(jpe?g)$/i);
  return m ? m[1] : "";
}

async function findProductIdBySkuPrefix(sku) {
  const q = `
    query FindBySku($query: String!) {
      productVariants(first: 10, query: $query) {
        edges {
          node {
            sku
            product { id title handle status }
          }
        }
      }
    }
  `;

  const attempts = [
    `sku:${sku}`,
    `sku:_${sku}`,
    `sku:${sku}*`,
    `sku:*${sku}*`
  ];

  for (const attempt of attempts) {
    const data = await shopifyGraphQL(q, { query: attempt });
    const edges = data.productVariants.edges || [];
    if (edges.length) {
      const p = edges[0].node.product;
      return {
        productId: p.id,
        productTitle: p.title,
        productHandle: p.handle,
        productStatus: p.status,
        queryUsed: attempt
      };
    }
  }

  return null;
}

async function stagedUploadJpeg(filename) {
  const mutation = `
    mutation Staged($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `;

  const data = await shopifyGraphQL(mutation, {
    input: [{
      resource: "IMAGE",
      filename,
      mimeType: "image/jpeg",
      httpMethod: "POST"
    }]
  });

  const r = data.stagedUploadsCreate;
  if (r.userErrors?.length) {
    throw new Error(`stagedUploadsCreate errors: ${JSON.stringify(r.userErrors)}`);
  }

  return r.stagedTargets[0];
}

async function uploadBufferToStagedTarget(stagedTarget, filename, buffer) {
  const form = new FormData();

  for (const p of stagedTarget.parameters) {
    form.append(p.name, p.value);
  }

  const blob = new Blob([buffer], { type: "image/jpeg" });
  form.append("file", blob, filename);

  const res = await fetch(stagedTarget.url, {
    method: "POST",
    body: form
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Staged upload failed HTTP ${res.status}: ${t.slice(0, 400)}`);
  }
}

async function createProductMedia(productId, resourceUrl, altText) {
  const mutation = `
    mutation Media($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { ... on MediaImage { id } }
        mediaUserErrors { field message code }
      }
    }
  `;

  const data = await shopifyGraphQL(mutation, {
    productId,
    media: [{
      mediaContentType: "IMAGE",
      originalSource: resourceUrl,
      alt: altText
    }]
  });

  const errs = data.productCreateMedia.mediaUserErrors || [];
  if (errs.length) {
    throw new Error(`productCreateMedia errors: ${JSON.stringify(errs)}`);
  }
}

function normalizeSkuTag(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  return raw.startsWith("__") ? raw : `__${raw}`;
}

function handleFromSkuTag(skuTag) {
  // Handle must be stable and URL-safe. Keep it simple.
  // "__101110006" -> "sku-101110006"
  const core = String(skuTag).replace(/^__+/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `sku-${core}`;
}

function isQuarterIncrement(n) {
  // multiples of 0.25
  return Math.round(n * 4) / 4 === n;
}

function roundToQuarter(n) {
  return Math.round(n * 4) / 4;
}

async function upsertSizeChartMetaobject({ skuTag, chartName, direction, columns, rows, footer }) {
  const mutation = `
    mutation Upsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
        metaobject { id handle type }
        userErrors { field message code }
      }
    }
  `;

  const handle = handleFromSkuTag(skuTag);

  const variables = {
    handle: { type: "size_chart", handle },
    metaobject: {
      fields: [
        { key: "sku_tag", value: skuTag },
        { key: "chart_name", value: chartName || "" },
        { key: "direction", value: direction || "row" },
        { key: "columns_json", value: JSON.stringify(columns || []) },
        { key: "rows_json", value: JSON.stringify(rows || []) },
        { key: "footer", value: footer || "" },
        { key: "source_id", value: "" },
        { key: "updated_at", value: new Date().toISOString() },
      ],
    },
  };

  const data = await shopifyGraphQL(mutation, variables);
  const r = data.metaobjectUpsert;
  if (r.userErrors?.length) throw new Error(`UserErrors: ${JSON.stringify(r.userErrors)}`);
  return r.metaobject;
}

async function findProductsByTag(skuTag) {
  const query = `
    query ProductsByTag($q: String!, $cursor: String) {
      products(first: 100, query: $q, after: $cursor) {
        edges { cursor node { id } }
        pageInfo { hasNextPage }
      }
    }
  `;

  const q = `tag:${skuTag}`;
  let cursor = null;
  const ids = [];

  while (true) {
    const data = await shopifyGraphQL(query, { q, cursor });
    const conn = data.products;
    conn.edges.forEach((e) => ids.push(e.node.id));
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.edges[conn.edges.length - 1].cursor;
    await sleep(120);
  }

  return ids;
}

async function setProductMetafieldsInBatches(productIds, metaobjectGid) {
  const mutation = `
    mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message code }
      }
    }
  `;

  // Shopify allows up to 25 metafields per call.
  const batches = [];
  for (let i = 0; i < productIds.length; i += 25) {
    batches.push(productIds.slice(i, i + 25));
  }

  for (const batch of batches) {
    const metafields = batch.map((ownerId) => ({
      ownerId,
      namespace: "custom",
      key: "size_chart",
      type: "metaobject_reference",
      value: metaobjectGid,
    }));

    const data = await shopifyGraphQL(mutation, { metafields });
    const errs = data.metafieldsSet.userErrors || [];
    if (errs.length) throw new Error(`metafieldsSet errors: ${JSON.stringify(errs)}`);

    await sleep(180);
  }
}

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://app.omnisend.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-bis-import");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB per image
});
const APP_PASSWORD = process.env.APP_PASSWORD || "";

function basicAuth(req, res, next) {
  if (req.path === "/api/bis/import") return next();
  if (!APP_PASSWORD) return next();

  const header = req.headers.authorization || "";
  const [type, encoded] = header.split(" ");

  if (type !== "Basic" || !encoded) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Size Chart Editor"');
    return res.status(401).send("Authentication required");
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const [user, pass] = decoded.split(":");

  if (pass !== APP_PASSWORD) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Size Chart Editor"');
    return res.status(401).send("Invalid password");
  }

  next();
}


app.use(basicAuth);
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "home.html"));
});

app.use(express.static(PUBLIC_DIR));
app.get("/api/templates", (req, res) => {
  res.json({
    men_bottoms: {
      label: "Men bottoms",
      sizes: ["27","28","29","30","31","32","33","34","36","38","40","42","44"],
      rows: ["Waist","Front Rise","Back Rise","Upper Thigh","Knee","Leg Opening","Inseam"],
      direction: "row",
    },
    women_bottoms: {
      label: "Women bottoms",
      sizes: ["23","24","25","26","27","28","29","30","31","32","33","34","36"],
      rows: ["Waist","Hips","Front Rise","Back Rise","Upper Thigh","Knee","Leg Opening","Inseam"],
      direction: "row",
    },
    tops: {
      label: "Tops",
      sizes: ["XS","S","M","L","XL","XXL"],
      rows: ["Shoulder","Pit to Pit","Sleeve Length","Body Length"],
      direction: "row",
    },
  });
});

app.post(
  "/api/retailer-list/preview",
  retailerUpload.fields([
    { name: "pdf", maxCount: 1 },
    { name: "retailers", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const pdfFile = req.files?.pdf?.[0];
      const csvFile = req.files?.retailers?.[0];

      if (!pdfFile) {
        return res.status(400).json({ error: "Missing PDF file" });
      }

let csvText = "";

if (csvFile) {
  csvText = csvFile.buffer.toString("utf8").replace(/^\uFEFF/, "");
} else {
  csvText = fs.readFileSync(path.join(__dirname, "data", "retailers.csv"), "utf8").replace(/^\uFEFF/, "");
}

const parser = new PDFParse({ data: pdfFile.buffer });
const data = await parser.getText();
await parser.destroy();

const text = data.text || "";

const csvRows = parse(csvText, {
  columns: true,
  skip_empty_lines: true,
  trim: true,
  bom: true
});


const savedAliases = loadSavedRetailerAliases();

const EXCLUDED_RETAILERS = new Set([
  "TATE AND YOKO NYC",
  "TATE ET YOKO",
  "TATE ET YOKO WAREHOUSE",
  "TATE AND YOKO",
  "TATE AND YOKO WAREHOUSE"
]);

const RETAILER_ALIASES = {
  "LA MAISON SIMONS": "Maison Simons",
  "DEE DEE RETAIL LTD": "Jeanstore",
  "DEE DEE RETAIL": "Jeanstore",
  "DEE DEE": "Jeanstore",
  "DUTIL TORONTO": "Dutil Denim",
  "GAN K": "Gank",
  "L E000 L EXCEPTION": "Lexception",
  "DREAMABLE SAS": "Smallable",
  "DREAMABLE": "Smallable",
  "LES HUSSARDS NOIRS": "Flaneurs",
  "MARYANNS": "Maryann's"
};

function applyRetailerRules(customerRaw, retailerRaw) {
  const normalizedRetailer = normalizeName(retailerRaw);
  const normalizedCustomer = normalizeName(customerRaw);

  if (
    EXCLUDED_RETAILERS.has(normalizedRetailer) ||
    EXCLUDED_RETAILERS.has(normalizedCustomer)
  ) {
    return { exclude: true, retailer: retailerRaw };
  }

  if (savedAliases[normalizedRetailer]) {
    return { exclude: false, retailer: savedAliases[normalizedRetailer] };
  }

  if (savedAliases[normalizedCustomer]) {
    return { exclude: false, retailer: savedAliases[normalizedCustomer] };
  }

  if (
    normalizedRetailer.includes("REVOLVER") ||
    normalizedCustomer.includes("REVOLVER")
  ) {
    if (normalizedCustomer.includes("BEND")) {
      return { exclude: false, retailer: "REVOLVR/Bend" };
    }
    if (normalizedCustomer.includes("BOZE") || normalizedCustomer.includes("BOZEMAN")) {
      return { exclude: false, retailer: "REVOLVR/Bozeman" };
    }
    if (normalizedCustomer.includes("PORT")) {
      return { exclude: false, retailer: "REVOLVR/Portland" };
    }
    if (normalizedCustomer.includes("MISS")) {
      return { exclude: false, retailer: "REVOLVR/Missoula" };
    }

    return { exclude: false, retailer: "REVOLVR" };
  }

  if (RETAILER_ALIASES[normalizedRetailer]) {
    return { exclude: false, retailer: RETAILER_ALIASES[normalizedRetailer] };
  }

  if (RETAILER_ALIASES[normalizedCustomer]) {
    return { exclude: false, retailer: RETAILER_ALIASES[normalizedCustomer] };
  }

  return { exclude: false, retailer: retailerRaw };
}

const csvDirectory = csvRows.map((row) => ({
  name: row.name || row.Name || "",
  url: row.url || row.URL || row.Url || row.website || row.Website || "",
  country: row.country || row.Country || "",
  normalizedName: normalizeName(row.name || row.Name || "")
}));

const customDirectory = loadCustomRetailers().map((row) => ({
  name: row.name || "",
  url: row.url || "",
  country: row.country || "",
  normalizedName: normalizeName(row.name || "")
}));

const directory = [...csvDirectory, ...customDirectory];

const lines = text
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

const FIT_MAP = {
  "03": "Weird Guy",
  "06": "Easy Guy",
  "16": "Strong Guy",
  "00": "Super Guy",
  "21": "True Guy",
  "35": "Groovy Guy",
  "64": "Denim Jacket",
  "49": "Zip Jacket",
  "65": "Chore Coat",
  "93": "Bestie",
  "46": "Maudie",
  "37": "True Girl",
  "88": "Wide Wild West",
  "14": "Wide Leg Trouser",
  "96": "Pleated Trouser",
  "25": "Kimono Shirt",
  "04": "Wise Guy Jacket"
};

const ALLOWED_STATUSES = new Set(["Allocated", "Complete"]);

const records = [];

let currentCustomerRaw = null;
let currentRetailerRaw = null;
let currentStyleSku = null;

for (const line of lines) {
  if (line.startsWith("Customer :")) {
    currentCustomerRaw = line.replace(/^Customer\s*:\s*/, "").trim();

    let retailer = currentCustomerRaw;
    retailer = retailer.replace(/^[A-Z]{3}\d{3}\s+/, "");
    retailer = retailer.replace(/^\d+\s+/, "");
    retailer = retailer.replace(/^\d+\s+/, "");
    retailer = retailer.replace(/\s*\(?DBA\b.*$/i, "").trim();

    const leadingParen = retailer.match(/^\(([^)]+)\)/);
    if (leadingParen) {
      retailer = leadingParen[1].trim();
    }

    retailer = retailer.replace(/\s+\d+(?:\s+\d+)*$/, "").trim();

    currentRetailerRaw = retailer;
    continue;
  }

  if (line.includes("Style :")) {
const styleMatch = line.match(/Style\s*:\s*([A-Z0-9]+)/i);
    if (styleMatch) {
      currentStyleSku = styleMatch[1].trim();
    }
    continue;
  }

if (
  line.startsWith("Total Style") ||
  line.startsWith("Total Customer") ||
  line.startsWith("Original") ||
  line.startsWith("Bal To Ship") ||
  line.startsWith("Allocated") ||
  line.startsWith("Picked") ||
  line.startsWith("Shipped") ||
  line.startsWith("Price :") ||
  line.startsWith("Order Type :") ||
  line.startsWith("Order Catg :")
) {
  continue;
}

const looksLikeOrderRow =
  /^[A-Z0-9]+\s+.*-\s+\d+\s+(Allocated|Complete|Cancelled|Outstanding|Invoiced|Picked)\b/i.test(line);

if (!looksLikeOrderRow) {
  continue;
}

const statusMatch = line.match(/\b(Allocated|Complete|Cancelled|Outstanding|Invoiced|Picked)\b/i);

if (statusMatch && currentCustomerRaw && currentStyleSku) {
  const status = statusMatch[1];

  if (!ALLOWED_STATUSES.has(status)) {
    continue;
  }

  const fitCode = currentStyleSku.slice(-2);
  const fit = FIT_MAP[fitCode] || null;

  const retailerRule = applyRetailerRules(currentCustomerRaw, currentRetailerRaw);

  if (retailerRule.exclude) {
    continue;
  }

  records.push({
    customerRaw: currentCustomerRaw,
    retailerRaw: retailerRule.retailer,
    styleSku: currentStyleSku,
    status,
    fitCode,
    fit
  });
}
}

const grouped = new Map();

for (const record of records) {
  const key = record.retailerRaw;

  if (!grouped.has(key)) {
    grouped.set(key, {
      retailerRaw: record.retailerRaw,
      fits: new Set()
    });
  }

  grouped.get(key).fits.add(record.fit);
}

const merged = Array.from(grouped.values())
  .map((item) => ({
    retailerRaw: item.retailerRaw,
    fits: Array.from(item.fits).filter(Boolean).sort()
  }))
  .sort((a, b) => a.retailerRaw.localeCompare(b.retailerRaw));

const matched = merged.map((item) => {
  const key = normalizeName(item.retailerRaw);

  let hit = directory.find((d) => d.normalizedName === key);

  if (!hit) {
    hit = directory.find((d) =>
      d.normalizedName.includes(key) ||
      key.includes(d.normalizedName)
    );
  }

  return {
    retailerRaw: item.retailerRaw,
    matchedName: hit ? hit.name : item.retailerRaw,
    url: hit ? hit.url : "",
    country: hit ? hit.country : "Unknown",
    fits: item.fits,
    isUnknown: !hit
  };
}); // ← VERY IMPORTANT

matched.sort((a, b) =>
  a.country.localeCompare(b.country) ||
  a.matchedName.localeCompare(b.matchedName)
);
const dedupedMap = new Map();

for (const item of matched) {
  const key = item.matchedName;

  if (!dedupedMap.has(key)) {
    dedupedMap.set(key, {
      ...item,
      fits: new Set(item.fits)
    });
  } else {
    const existing = dedupedMap.get(key);
    item.fits.forEach((f) => existing.fits.add(f));
  }
}

const deduped = Array.from(dedupedMap.values()).map((item) => ({
  ...item,
  fits: Array.from(item.fits)
}));

const byCountry = new Map();

for (const item of deduped) {
  const country = item.country || "Unknown";

  if (!byCountry.has(country)) {
    byCountry.set(country, []);
  }

  byCountry.get(country).push(item);
}
const unknownRetailers = deduped
  .filter((item) => item.isUnknown)
  .map((item) => item.retailerRaw);

const retailerOptions = directory
  .map((d) => d.name)
  .filter(Boolean)
  .sort((a, b) => a.localeCompare(b));

const formattedBlocks = Array.from(byCountry.entries()).map(([country, retailers]) => {
  const lines = retailers.map((item) => {
    const label = item.url
      ? `${item.matchedName} (${item.url})`
      : item.matchedName;

    return `${label} - ${item.fits.join(", ")}`;
  });

  return `${country}:\n\n${lines.join("\n")}`;
});

const formattedText = formattedBlocks.join("\n\n");

const htmlBlocks = Array.from(byCountry.entries()).map(([country, retailers]) => {
  const lines = retailers.map((item) => {
    const label = item.url
      ? `<a href="${item.url}" target="_blank" rel="noopener noreferrer">${item.matchedName}</a>`
      : item.matchedName;

    return `${label} - ${item.fits.join(", ")}`;
  });

  return `<strong>${country}:</strong><br><br>${lines.join("<br>")}`;
});

const formattedHtml = htmlBlocks.join("<br><br>");
return res.json({
  ok: true,
  totalLines: lines.length,
  totalCsvRows: csvRows.length,
  totalRecords: records.length,
  totalRetailers: deduped.length,
  preview: deduped.slice(0, 25),
  formattedText,
  formattedHtml,
  unknownRetailers,
  retailerOptions
});

    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

app.post("/api/retailer-list/save-alias", express.json(), (req, res) => {
  try {
    const unknownRetailer = String(req.body?.unknownRetailer || "").trim();
    const selectedRetailer = String(req.body?.selectedRetailer || "").trim();

    if (!unknownRetailer) {
      return res.status(400).json({ ok: false, error: "Missing unknownRetailer" });
    }

    if (!selectedRetailer) {
      return res.status(400).json({ ok: false, error: "Missing selectedRetailer" });
    }

    const aliases = loadSavedRetailerAliases();
    aliases[normalizeName(unknownRetailer)] = selectedRetailer;
    saveRetailerAliases(aliases);

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/retailer-list/add-retailer", express.json(), (req, res) => {
  try {
    const unknownRetailer = String(req.body?.unknownRetailer || "").trim();
    const name = String(req.body?.name || "").trim();
    const url = String(req.body?.url || "").trim();
    const country = String(req.body?.country || "").trim();

    if (!unknownRetailer) {
      return res.status(400).json({ ok: false, error: "Missing unknownRetailer" });
    }

    if (!name) {
      return res.status(400).json({ ok: false, error: "Missing retailer name" });
    }

    if (!country) {
      return res.status(400).json({ ok: false, error: "Missing country" });
    }

    const customRetailers = loadCustomRetailers();
    const exists = customRetailers.some(
      (item) => normalizeName(item.name) === normalizeName(name)
    );

    if (!exists) {
customRetailers.push({
  name,
  url,
  country,
  addedAt: new Date().toISOString(),
  syncedToLocator: false
});
      saveCustomRetailers(customRetailers);
    }

    const aliases = loadSavedRetailerAliases();
    aliases[normalizeName(unknownRetailer)] = name;
    saveRetailerAliases(aliases);

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/retailer-list/custom-retailers", (req, res) => {
  try {
    const items = loadCustomRetailers();
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/retailer-list/mark-synced", express.json(), (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();

    if (!name) {
      return res.status(400).json({ ok: false, error: "Missing name" });
    }

    const items = loadCustomRetailers().map((item) => {
      if (item.name === name) {
        return { ...item, syncedToLocator: true };
      }
      return item;
    });

    saveCustomRetailers(items);

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/save", async (req, res) => {
  try {
    const skuTag = normalizeSkuTag(req.body.skuTag);
    if (!skuTag) return res.status(400).json({ error: "Missing skuTag" });

    const templateKey = String(req.body.templateKey || "");
    const chartName = String(req.body.chartName || "");
    const direction = String(req.body.direction || "row");
    const sizes = Array.isArray(req.body.sizes) ? req.body.sizes.map(String) : [];
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const footer = String(req.body.footer || "");

    if (!sizes.length) return res.status(400).json({ error: "Missing sizes" });
    if (!rows.length) return res.status(400).json({ error: "Missing rows" });

    // Validate and normalize numeric cells to quarter inches
    // rows format: [{ label, values: [..] }]
    const normalizedRows = rows.map((r) => {
      const label = String(r.label || "").trim();
      const values = Array.isArray(r.values) ? r.values : [];
      const outValues = values.map((v) => {
        if (v === null || v === undefined || String(v).trim() === "") return null;
        const n = Number(String(v).trim());
        if (!Number.isFinite(n)) throw new Error(`Invalid number in ${label}: ${v}`);
        const rounded = roundToQuarter(n);
        if (!isQuarterIncrement(rounded)) throw new Error(`Invalid quarter increment in ${label}: ${v}`);
        // Keep as string like your current data
        return String(rounded % 1 === 0 ? rounded.toFixed(0) : rounded);
      });
      return { label, unit: "in", values: outValues };
    });

    const columns = ["Tag Size", ...sizes];

    const meta = await upsertSizeChartMetaobject({
      skuTag,
      chartName: chartName || templateKey || skuTag,
      direction,
      columns,
      rows: normalizedRows,
      footer,
    });

    const productIds = await findProductsByTag(skuTag);
    await setProductMetafieldsInBatches(productIds, meta.id);

    res.json({
      ok: true,
      skuTag,
      metaobjectId: meta.id,
      linkedProducts: productIds.length,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.post("/api/image-import", upload.array("files", 50), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ ok: false, error: "No files uploaded" });
    }

    const results = [];

    for (const f of files) {
      const name = f.originalname || "image.jpg";

      if (!/\.jpe?g$/i.test(name)) {
        results.push({ filename: name, status: "SKIP_NOT_JPEG" });
        continue;
      }

      const sku = parseSkuFromFilename(name);
      const suffix = parseSuffixFromFilename(name);

      if (!sku) {
        results.push({ filename: name, status: "SKIP_NO_SKU" });
        continue;
      }

      const found = await findProductIdBySkuPrefix(sku);

      if (!found) {
        results.push({ filename: name, sku, status: "SKIP_NO_PRODUCT" });
        continue;
      }

      const alt = `SKU ${sku}${suffix ? " " + suffix : ""}`;

      const staged = await stagedUploadJpeg(name);
      await uploadBufferToStagedTarget(staged, name, f.buffer);
      await createProductMedia(found.productId, staged.resourceUrl, alt);

      results.push({
        filename: name,
        sku,
        status: "IMPORTED",
        productHandle: found.productHandle,
        productStatus: found.productStatus,
        matchedBy: found.queryUsed
      });

      await sleep(250);
    }

    res.json({ ok: true, count: results.length, results });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});


// ===============================
// SIZE CHART AUDIT API (paginated)
// ===============================
app.get("/api/audit", async (req, res) => {
  try {
    const cursor = req.query.cursor || null;

    const query = `
      query Audit($cursor: String) {
        products(first: 100, after: $cursor) {
          edges {
            cursor
            node {
              title
              handle
              tags
              metafield(namespace: "custom", key: "size_chart") {
                reference {
                  ... on Metaobject {
                    handle
                    displayName
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    `;

    const data = await shopifyGraphQL(query, { cursor });

    const edges = data.products.edges || [];

    const items = edges.map(e => {
      const p = e.node;
      const chartRef = p.metafield && p.metafield.reference ? p.metafield.reference : null;

      // prefer numeric __SKU tags
      let skuTag = "";
      for (const t of (p.tags || [])) {
        if (t.startsWith("__")) {
          const core = t.replace(/^__+/, "");
          if (/^\d+$/.test(core)) { skuTag = t; break; }
        }
      }
      if (!skuTag) skuTag = (p.tags || []).find(t => t.startsWith("__")) || "";

      return {
        title: p.title,
        handle: p.handle,
        skuTag,
        chartName: chartRef ? (chartRef.displayName || "") : "",
        chartHandle: chartRef ? (chartRef.handle || "") : "",
      };
    });

    res.json({
      ok: true,
      items,
      nextCursor: edges.length ? edges[edges.length - 1].cursor : null,
      hasNextPage: !!data.products.pageInfo.hasNextPage
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ===============================
// LIST SIZE CHART METAOBJECTS
// ===============================
// ===============================
// LIST SIZE CHART METAOBJECTS (+ optional usage counts)
// ===============================
let _usageCache = { ts: 0, map: null };
const USAGE_CACHE_MS = 5 * 60 * 1000;

async function getUsageMap() {
  const now = Date.now();
  if (_usageCache.map && (now - _usageCache.ts) < USAGE_CACHE_MS) return _usageCache.map;

  const q = `
    query ProductsWithCharts($cursor: String) {
      products(first: 250, after: $cursor) {
        edges {
          cursor
          node {
            metafield(namespace: "custom", key: "size_chart") {
              reference {
                ... on Metaobject { id }
              }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  `;

  let cursor = null;
  let hasNext = true;
  const map = {}; // metaobjectId -> count

  while (hasNext) {
    const data = await shopifyGraphQL(q, { cursor });
    const edges = data.products.edges || [];

    for (const e of edges) {
      const ref = e.node.metafield?.reference;
      if (ref?.id) {
        map[ref.id] = (map[ref.id] || 0) + 1;
      }
      cursor = e.cursor;
    }

    hasNext = !!data.products.pageInfo.hasNextPage;
    if (!edges.length) break;
  }

  _usageCache = { ts: now, map };
  return map;
}

app.get("/api/charts", async (req, res) => {
  try {
    const includeUsage = String(req.query.includeUsage || "") === "1";
    const cursor = req.query.cursor || null;

    const query = `
      query Charts($cursor: String) {
        metaobjects(type: "size_chart", first: 100, after: $cursor) {
          edges {
            cursor
            node {
              id
              handle
              updatedAt
              fields { key value }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    `;

    const usage = includeUsage ? await getUsageMap() : null;

    const data = await shopifyGraphQL(query, { cursor });
    const edges = data.metaobjects.edges || [];

    const items = edges.map(e => {
      const m = e.node;
      const field = (k) => (m.fields || []).find(f => f.key === k)?.value || "";
      const linkedCount = usage ? (usage[m.id] || 0) : null;

      return {
        id: m.id,
        handle: m.handle,
        updatedAt: m.updatedAt,
        skuTag: field("sku_tag"),
        chartName: field("chart_name"),
        direction: field("direction"),
        linkedCount,
        isOrphan: usage ? ((usage[m.id] || 0) === 0) : null
      };
    });

    res.json({
      ok: true,
      items,
      nextCursor: edges.length ? edges[edges.length - 1].cursor : null,
      hasNextPage: !!data.metaobjects.pageInfo.hasNextPage
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
// ===============================
// FETCH ONE CHART BY SKU TAG FIELD
// ===============================

app.get("/api/chart", async (req, res) => {
  try {

    const chartId = String(req.query.id || "").trim();
    if (chartId) {
      const qById = `
        query GetChartById($id: ID!) {
          metaobject(id: $id) {
            id
            handle
            type
            fields { key value }
          }
        }
      `;

      const dataById = await shopifyGraphQL(qById, { id: chartId });
      const m = dataById.metaobject;
      if (!m) return res.json({ ok:false, error:"Chart not found" });

      const field = (k) => (m.fields || []).find(f => f.key === k)?.value || "";

      return res.json({
        ok: true,
        id: m.id,
        handle: m.handle,
        skuTag: field("sku_tag"),
        chartName: field("chart_name"),
        direction: field("direction") || "row",
        columns_json: field("columns_json") || "[]",
        rows_json: field("rows_json") || "[]",
        footer: field("footer") || ""
      });
    }

    const skuTag = normalizeSkuTag(req.query.sku || req.query.handle || "");
    if (!skuTag) return res.status(400).json({ ok: false, error: "Missing sku" });

    const query = `
      query FindChart($q: String) {
        metaobjects(type: "size_chart", first: 5, query: $q) {
          edges {
            node {
              id
              handle
              fields { key value }
            }
          }
        }
      }
    `;

    // Try both underscore variants because your data has _ and __
    const candidates = [skuTag, "_" + skuTag.replace(/^__+/, ""), "__" + skuTag.replace(/^_+/, "")];

    let found = null;
    let tried = [];

    for (const c of candidates) {
      tried.push(c);
      const data = await shopifyGraphQL(query, { q: `sku_tag:${c}` });
      const edge = (data.metaobjects.edges || [])[0];
      if (edge && edge.node) {
        found = edge.node;
        break;
      }
    }

    if (!found) return res.json({ ok: false, error: "Chart not found", tried });

    const field = (k) => (found.fields || []).find(f => f.key === k)?.value || "";

    res.json({
      ok: true,
      id: found.id,
      handle: found.handle,
      skuTag: field("sku_tag"),
      chartName: field("chart_name"),
      direction: field("direction") || "row",
      columns_json: field("columns_json") || "[]",
      rows_json: field("rows_json") || "[]",
      footer: field("footer") || ""
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ===============================
// DUPLICATE A SIZE CHART (new handle = newSkuTag)
// ===============================
app.post("/api/duplicate_chart", async (req, res) => {
  try {
    const sourceId = String(req.body?.sourceChartId || "").trim();
    const newSkuTag = normalizeSkuTag(req.body?.newSkuTag || "");
    const newChartName = String(req.body?.newChartName || "").trim();

    if (!sourceId) return res.status(400).json({ ok: false, error: "Missing sourceChartId" });
    if (!newSkuTag) return res.status(400).json({ ok: false, error: "Missing newSkuTag" });
    if (!newChartName) return res.status(400).json({ ok: false, error: "Missing newChartName" });

    // 1) Load source chart by ID
    const qById = `
      query GetChartById($id: ID!) {
        metaobject(id: $id) {
          id
          handle
          type
          fields { key value }
        }
      }
    `;
    const srcData = await shopifyGraphQL(qById, { id: sourceId });
    const src = srcData.metaobject;
    if (!src) return res.status(404).json({ ok: false, error: "Source chart not found" });

    const srcField = (k) => (src.fields || []).find(f => f.key === k)?.value || "";

    // 2) Build new fields by copying source and overriding SKU + name + updatedAt
    const nowIso = new Date().toISOString();

    const fields = [
      { key: "sku_tag", value: newSkuTag },
      { key: "chart_name", value: newChartName },
      { key: "direction", value: srcField("direction") || "row" },
      { key: "columns_json", value: srcField("columns_json") || "[]" },
      { key: "rows_json", value: srcField("rows_json") || "[]" },
      { key: "footer", value: srcField("footer") || "" },
      // Optional fields if your definition has them:
      { key: "source_id", value: srcField("source_id") || "" },
      { key: "updated_at", value: nowIso }
    ].filter(f => f.value !== undefined);

    // 3) Create new metaobject with handle exactly = SKU tag
    const createMutation = `
      mutation CreateChart($input: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $input) {
          metaobject { id handle }
          userErrors { field message }
        }
      }
    `;

    const createInput = {
      type: "size_chart",
      handle: newSkuTag,
      fields
    };

    const created = await shopifyGraphQL(createMutation, { input: createInput });
    const errs = created.metaobjectCreate?.userErrors || [];
    const mo = created.metaobjectCreate?.metaobject;

    if (errs.length || !mo) {
      return res.status(400).json({ ok: false, error: "Could not duplicate chart", userErrors: errs });
    }

    return res.json({ ok: true, newChartId: mo.id, newHandle: mo.handle });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

let BIS_CACHE = null;
let BIS_CACHE_AT = 0;
let BIS_JOB = {
  running: false,
  startedAt: null,
  finishedAt: null,
  passesDone: 0,
  pagesDone: 0,
  rowsFound: 0,
  error: null
};

const PASSES = [
  { sortBy: "waitingContactsCount", sortOrder: "desc" },
  { sortBy: "lastRequestedAt", sortOrder: "asc" },
  { sortBy: "lastRequestedAt", sortOrder: "desc" }
];

async function fetchAmpDemand() {
  const ampToken = String(process.env.AMP_TOKEN || "").trim();
  if (!ampToken) {
    return [];
  }

  const AMP_ENDPOINT = "https://app.backinstock.org/api/variants";
  let page = 1;
  let more = true;
  const acc = {};

  while (more) {
    const auth = Buffer.from(`${ampToken}:`).toString("base64");

    const res = await fetch(`${AMP_ENDPOINT}?per_page=250&page=${page}`, {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`
      }
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AMP API ${res.status}: ${text.slice(0, 300)}`);
    }

    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) break;

    for (const row of arr) {
const sku = String(row?.sku || "").trim();
const demand = Number(row?.unsent_notifications_count || 0);
const description = String(row?.description || "").trim();

if (!sku) continue;
if (demand <= 0) continue;

if (!acc[sku]) {
  acc[sku] = {
    sku,
    demand: 0,
    description
  };
}

acc[sku].demand += demand;

if (!acc[sku].description && description) {
  acc[sku].description = description;
}
    }

    more = arr.length >= 250;
    page += 1;

    if (more) {
      await new Promise(r => setTimeout(r, 80));
    }
  }

return Object.values(acc)
  .sort((a, b) => b.demand - a.demand);
}
async function refreshBisData() {
  if (BIS_JOB.running) return;

  BIS_JOB = {
    running: true,
    startedAt: Date.now(),
    finishedAt: null,
    passesDone: 0,
    pagesDone: 0,
    rowsFound: 0,
    error: null
  };

  try {
    const cookie = process.env.OMNISEND_COOKIE;
const ampRows = await fetchAmpDemand();
const ampBySku = Object.fromEntries(ampRows.map(r => [r.sku, r.demand]));    
const limit = 25;
    const seen = new Set();
    const all = [];

    for (const pass of PASSES) {
      let offset = 0;

      while (true) {
        const url =
          "https://app.omnisend.com/REST/contactProductsSubscriptions/v1/requestedProducts" +
          `?limit=${limit}&offset=${offset}&sortBy=${pass.sortBy}&sortOrder=${pass.sortOrder}`;

const r = await fetch(url, {
  headers: {
    Accept: "application/json",
    Cookie: cookie
  }
});

const text = await r.text();

if (!r.ok) {
  throw new Error(`Omnisend ${r.status}: ${text.slice(0, 300)}`);
}

let json;
try {
  json = text ? JSON.parse(text) : {};
} catch (e) {
  throw new Error(`Omnisend returned non-JSON response: ${text.slice(0, 300)}`);
}

const items = json.requestedProducts || [];
const cleaned = items.filter(item => String(item?.sku || "").trim());

        BIS_JOB.pagesDone += 1;

        if (!items.length) break;

for (const item of cleaned) {
          const key = `${item.productID}-${item.variantID}-${item.sku}`;
          if (!seen.has(key)) {
            seen.add(key);
            all.push(item);
          }
        }

        BIS_JOB.rowsFound = all.length;
        offset += limit;
      }
      BIS_JOB.passesDone += 1;
    }

const merged = all.map(item => {
  const sku = String(item.sku || "").trim();
  const omnisendCount = Number(item.waitingContactsCount || 0);
  const ampCount = Number(ampBySku[sku] || 0);

  return {
    ...item,
    omnisendCount,
    ampCount,
    totalCount: omnisendCount + ampCount
  };
});

const existingSkus = new Set(
  merged.map(item => String(item.sku || "").trim())
);

for (const row of ampRows) {
  const sku = String(row.sku || "").trim();
  if (!sku || existingSkus.has(sku)) continue;

  merged.push({
    productID: "",
    variantID: "",
productTitle: row.description || "AMP-only",
    variantTitle: "",
    url: "",
    sku,
    waitingContactsCount: 0,
    lastRequestedAt: "",
    omnisendCount: 0,
    ampCount: Number(row.demand || 0),
    totalCount: Number(row.demand || 0)
  });
}

BIS_CACHE = merged;
BIS_CACHE_AT = Date.now();
    BIS_JOB.finishedAt = Date.now();
    BIS_JOB.running = false;
  } catch (e) {
    BIS_JOB.error = String(e.message || e);
    BIS_JOB.finishedAt = Date.now();
    BIS_JOB.running = false;
  }
}
app.post("/api/bis/import", async (req, res) => {
 const token = String(req.headers["x-bis-import"] || "").trim();
if (!process.env.BIS_IMPORT_TOKEN || token !== process.env.BIS_IMPORT_TOKEN) {
  return res.status(403).json({ ok: false, error: "Unauthorized import" });
}
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ ok: false, error: "No items provided" });
    }

    const ampRows = await fetchAmpDemand();
    const ampBySku = Object.fromEntries(ampRows.map(r => [r.sku, r.demand]));

    const seen = new Set();
    const cleaned = [];

    for (const item of items) {
      const sku = String(item?.sku || "").trim();
      if (!sku) continue;

      const key = `${item.productID || ""}-${item.variantID || ""}-${sku}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const omnisendCount = Number(item.waitingContactsCount || 0);
      const ampCount = Number(ampBySku[sku] || 0);

      cleaned.push({
        ...item,
        omnisendCount,
        ampCount,
        totalCount: omnisendCount + ampCount
      });
    }

    const existingSkus = new Set(cleaned.map(item => String(item.sku || "").trim()));

    for (const row of ampRows) {
      const sku = String(row.sku || "").trim();
      if (!sku || existingSkus.has(sku)) continue;

      cleaned.push({
        productID: "",
        variantID: "",
        productTitle: row.description || "AMP-only",
        variantTitle: "",
        url: "",
        sku,
        waitingContactsCount: 0,
        lastRequestedAt: "",
        omnisendCount: 0,
        ampCount: Number(row.demand || 0),
        totalCount: Number(row.demand || 0)
      });
    }

    BIS_CACHE = cleaned;
    BIS_CACHE_AT = Date.now();
    BIS_JOB = {
      running: false,
      startedAt: null,
      finishedAt: Date.now(),
      passesDone: 0,
      pagesDone: 0,
      rowsFound: cleaned.length,
      error: null
    };

    res.json({ ok: true, count: cleaned.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
app.get("/api/bis", async (req, res) => {
  return res.json({
    ok: true,
    count: BIS_CACHE ? BIS_CACHE.length : 0,
    items: BIS_CACHE || [],
    cached: true,
    cacheAt: BIS_CACHE_AT || null
  });
});
app.post("/api/bis/refresh", async (req, res) => {
  if (BIS_JOB.running) {
    return res.json({ ok: true, started: false, message: "Already running" });
  }

  refreshBisData(); // start background job

  res.json({
    ok: true,
    started: true
  });
});

app.get("/api/bis/status", async (req, res) => {
  res.json({
    ok: true,
    job: BIS_JOB,
    cacheCount: BIS_CACHE ? BIS_CACHE.length : 0,
    cacheAt: BIS_CACHE_AT
  });
});

app.listen(PORT, () => {
  console.log(`Size Chart app running at http://localhost:${PORT}`);
});
