require("dotenv").config();
const express = require("express");
const path = require("path");

const SHOP_DOMAIN = process.env.SHOP_DOMAIN;
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const API_VERSION = process.env.API_VERSION || "2025-01";
const PORT = Number(process.env.PORT || 8787);

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
const APP_PASSWORD = process.env.APP_PASSWORD || "";

function basicAuth(req, res, next) {
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
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.type("html");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

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

app.listen(PORT, () => {
  console.log(`Size Chart app running at http://localhost:${PORT}`);
});