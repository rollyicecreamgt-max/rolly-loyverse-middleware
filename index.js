import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * Helper: fetch JSON with Loyverse auth + better error
 */
async function loyverseFetch(url, token, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    const err = new Error("LOYVERSE_API_ERROR");
    err.status = resp.status;
    err.data = data;
    throw err;
  }

  return data;
}

/**
 * Helper: fetch ALL pages using cursor pagination
 * Works with endpoints that return:
 * - { items: [...], cursor: "..." }
 * - { variants: [...], cursor: "..." }
 * - { item_variants: [...], cursor: "..." }
 */
async function fetchAllWithCursor(urlBase, token) {
  let all = [];
  let cursor = null;

  while (true) {
    const url = cursor ? `${urlBase}?cursor=${encodeURIComponent(cursor)}` : urlBase;
    const data = await loyverseFetch(url, token);

    const list =
      data.items ||
      data.variants ||
      data.item_variants ||
      data.data ||
      [];

    all.push(...list);

    if (!data.cursor) break;
    cursor = data.cursor;
  }

  return all;
}

/**
 * Create order (creates a Loyverse receipt)
 * Input expected:
 * {
 *   note: "optional",
 *   payment_type_id: "UUID",
 *   line_items: [
 *     { variant_id: "UUID", quantity: 1, line_note: "text optional" }
 *   ]
 * }
 *
 * We calculate total using Loyverse /item_variants prices and set payments[0].money_amount = total.
 */
app.post("/orders", async (req, res) => {
  try {
    const store_id = process.env.LOYVERSE_STORE_ID;
    const token = process.env.LOYVERSE_TOKEN;

    if (!store_id) return res.status(500).json({ error: "Missing LOYVERSE_STORE_ID env var" });
    if (!token) return res.status(500).json({ error: "Missing LOYVERSE_TOKEN env var" });

    const { line_items, note, payment_type_id } = req.body || {};

    // Validate line_items
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({
        error: "Invalid payload",
        details: "line_items must be a non-empty array",
        example: {
          line_items: [{ variant_id: "UUID", quantity: 1, line_note: "Helado Natural - Vainilla - Normal" }],
          payment_type_id: "UUID",
          note: "Pedido GPT - Mostrador"
        }
      });
    }

    // Validate payment_type_id
    if (!payment_type_id || typeof payment_type_id !== "string") {
      return res.status(400).json({
        error: "Invalid payload",
        details: "payment_type_id is required (string)",
        example: {
          line_items: [{ variant_id: "UUID", quantity: 1, line_note: "Helado Natural - Vainilla - Normal" }],
          payment_type_id: "UUID",
          note: "Pedido GPT - Mostrador"
        }
      });
    }

    for (const [i, li] of line_items.entries()) {
      if (!li?.variant_id || typeof li.variant_id !== "string") {
        return res.status(400).json({ error: "Invalid line_items", details: `line_items[${i}].variant_id required` });
      }
      if (li?.quantity === undefined || li?.quantity === null || typeof li.quantity !== "number" || li.quantity <= 0) {
        return res.status(400).json({
          error: "Invalid line_items",
          details: `line_items[${i}].quantity must be > 0 (number)`
        });
      }
    }

    // 1) Load ALL item_variants to price map (cursor pagination)
    const itemVariants = await fetchAllWithCursor("https://api.loyverse.com/v1.0/item_variants", token);

    const priceByVariantId = new Map(
      itemVariants
        .filter(v => v?.id)
        .map(v => [v.id, Number(v.default_price ?? v.price ?? 0)])
    );

    // 2) Calculate total from incoming line_items
    let total = 0;
    for (const li of line_items) {
      const price = priceByVariantId.get(li.variant_id);
      if (price === undefined) {
        return res.status(400).json({
          error: "UNKNOWN_VARIANT_ID",
          details: `variant_id not found in Loyverse: ${li.variant_id}`
        });
      }
      total += price * li.quantity;
    }

    // 3) Build receipt payload
    const payload = {
      store_id,
      note: note || "Pedido GPT - Mostrador",
      line_items: line_items.map(li => ({
        variant_id: li.variant_id,
        quantity: li.quantity,
        line_note: li.line_note || ""
      })),
      payments: [
        {
          payment_type_id,
          money_amount: Number(total),
          paid_at: new Date().toISOString()
        }
      ]
    };

    // 4) Create receipt
    const receipt = await loyverseFetch("https://api.loyverse.com/v1.0/receipts", token, {
      method: "POST",
      body: JSON.stringify(payload)
    });

    return res.status(200).json({ ok: true, receipt });
  } catch (err) {
    // If it's a Loyverse API error, return details cleanly
    if (err?.message === "LOYVERSE_API_ERROR") {
      return res.status(400).json({
        error: "LOYVERSE_REJECTED_REQUEST",
        status: err.status,
        loyverse: err.data
      });
    }
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * Debug endpoints (optional but useful)
 */

// Items (may be paginated on Loyverse side; here we fetch all)
app.get("/loyverse/items", async (req, res) => {
  try {
    const token = process.env.LOYVERSE_TOKEN;
    if (!token) return res.status(500).json({ error: "Missing LOYVERSE_TOKEN env var" });

    const items = await fetchAllWithCursor("https://api.loyverse.com/v1.0/items", token);

    const simplified = items.map(item => ({
      item_id: item.id,
      name: item.item_name
    }));

    res.json({ count: simplified.length, items: simplified });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Item variants (this is what we use for pricing)
app.get("/loyverse/item_variants", async (req, res) => {
  try {
    const token = process.env.LOYVERSE_TOKEN;
    if (!token) return res.status(500).json({ error: "Missing LOYVERSE_TOKEN env var" });

    const itemVariants = await fetchAllWithCursor("https://api.loyverse.com/v1.0/item_variants", token);

    const simplified = itemVariants.map(v => ({
      variant_id: v.id,
      item_id: v.item_id,
      sku: v.sku,
      option1_value: v.option1_value,
      option2_value: v.option2_value,
      option3_value: v.option3_value,
      default_price: v.default_price ?? v.price
    }));

    res.json({ count: simplified.length, item_variants: simplified });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Full catalog: join items + variants, with cursor pagination
app.get("/loyverse/catalog", async (req, res) => {
  try {
    const token = process.env.LOYVERSE_TOKEN;
    if (!token) return res.status(500).json({ error: "Missing LOYVERSE_TOKEN env var" });

    // 1) All items
    const items = await fetchAllWithCursor("https://api.loyverse.com/v1.0/items", token);
    const itemNameById = new Map(items.map(i => [i.id, i.item_name]));

    // 2) All item_variants (more reliable for your use-case)
    const itemVariants = await fetchAllWithCursor("https://api.loyverse.com/v1.0/item_variants", token);

    // 3) Enriched output
    const enriched = itemVariants.map(v => ({
      item_id: v.item_id,
      item_name: itemNameById.get(v.item_id) || null,
      raw: {
        variant_id: v.id,
        item_id: v.item_id,
        sku: v.sku,
        option1_value: v.option1_value,
        option2_value: v.option2_value,
        option3_value: v.option3_value,
        default_price: v.default_price ?? v.price,
        stores: v.stores,
        created_at: v.created_at,
        updated_at: v.updated_at,
        deleted_at: v.deleted_at
      }
    }));

    res.json({ count: enriched.length, variants: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server (keep at the end)
app.listen(PORT, () => {
  console.log(`Rolly middleware running on port ${PORT}`);
});
