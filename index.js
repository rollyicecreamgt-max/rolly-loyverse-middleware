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

// Helpers
function toNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : NaN;
}

function getVariantPriceForStore(variant, storeId) {
  // Prioridad:
  // 1) Precio en stores[] para ese store_id
  // 2) default_price
  // 3) price
  const storePrice =
    Array.isArray(variant?.stores)
      ? variant.stores.find((s) => s?.store_id === storeId)?.price
      : undefined;

  if (storePrice !== undefined && storePrice !== null) return toNumber(storePrice);

  if (variant?.default_price !== undefined && variant?.default_price !== null) {
    return toNumber(variant.default_price);
  }

  if (variant?.price !== undefined && variant?.price !== null) {
    return toNumber(variant.price);
  }

  return NaN;
}

// Create order -> Create Loyverse receipt
app.post("/orders", async (req, res) => {
  try {
    const store_id = process.env.LOYVERSE_STORE_ID;
    const token = process.env.LOYVERSE_TOKEN;

    if (!store_id) return res.status(500).json({ error: "Missing LOYVERSE_STORE_ID env var" });
    if (!token) return res.status(500).json({ error: "Missing LOYVERSE_TOKEN env var" });

    const { line_items, note, payment_type_id } = req.body || {};

    // Validación: line_items
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({
        error: "Invalid payload",
        details: "line_items must be a non-empty array",
        example: {
          line_items: [{ variant_id: "UUID", quantity: 1, line_note: "Mora - Normal" }],
          payment_type_id: "UUID",
          note: "Pedido GPT - Mostrador"
        }
      });
    }

    // Validación: payment_type_id
    if (!payment_type_id || typeof payment_type_id !== "string") {
      return res.status(400).json({
        error: "Invalid payload",
        details: "payment_type_id is required (string)",
        example: {
          line_items: [{ variant_id: "UUID", quantity: 1, line_note: "Mora - Normal" }],
          payment_type_id: "UUID",
          note: "Pedido GPT - Mostrador"
        }
      });
    }

    // Validación por item (acepta quantity como número o string numérica)
    for (const [i, li] of line_items.entries()) {
      if (!li?.variant_id || typeof li.variant_id !== "string") {
        return res.status(400).json({
          error: "Invalid line_items",
          details: `line_items[${i}].variant_id required (string)`
        });
      }
      const qty = toNumber(li?.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({
          error: "Invalid line_items",
          details: `line_items[${i}].quantity must be > 0 (number)`
        });
      }
    }

    // 1) Cargar variants para calcular total
    const variantsResp = await fetch("https://api.loyverse.com/v1.0/variants", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    const variantsData = await variantsResp.json();
    if (!variantsResp.ok) {
      return res.status(500).json({
        error: "FAILED_TO_LOAD_VARIANTS",
        loyverse: variantsData
      });
    }

    const variantsList = variantsData.variants || [];

    const variantById = new Map(
      variantsList
        .filter((v) => v?.id)
        .map((v) => [v.id, v])
    );

    // 2) Calcular total con el precio real
    let total = 0;

    for (const li of line_items) {
      const variant = variantById.get(li.variant_id);

      if (!variant) {
        return res.status(400).json({
          error: "UNKNOWN_VARIANT_ID",
          details: `variant_id not found in Loyverse: ${li.variant_id}`
        });
      }

      const price = getVariantPriceForStore(variant, store_id);
      if (!Number.isFinite(price)) {
        return res.status(500).json({
          error: "PRICE_NOT_AVAILABLE",
          details: `Could not determine price for variant_id: ${li.variant_id}`,
          variant_preview: variant
        });
      }

      const qty = toNumber(li.quantity);
      total += price * qty;
    }

    // 3) Armar payload del receipt
    const payload = {
      store_id,
      note: note || "Pedido GPT - Mostrador",
      line_items: line_items.map((li) => ({
        variant_id: li.variant_id,
        quantity: toNumber(li.quantity),
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

    // 4) Crear receipt en Loyverse
    const response = await fetch("https://api.loyverse.com/v1.0/receipts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      return res.status(400).json({
        error: "LOYVERSE_REJECTED_RECEIPT",
        status: response.status,
        loyverse: data,
        sent_payload: payload
      });
    }

    return res.status(200).json({
      ok: true,
      receipt: data
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

// Optional: list items (simple view)
app.get("/loyverse/items", async (req, res) => {
  try {
    const token = process.env.LOYVERSE_TOKEN;

    const response = await fetch("https://api.loyverse.com/v1.0/items", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!response.ok) {
      return res.status(500).json({ error: data });
    }

    const simplified = (data.items || []).map((item) => ({
      item_id: item.id,
      name: item.item_name
    }));

    res.json({ count: simplified.length, items: simplified });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Optional: list variants (simple view)
app.get("/loyverse/variants", async (req, res) => {
  try {
    const token = process.env.LOYVERSE_TOKEN;

    const response = await fetch("https://api.loyverse.com/v1.0/variants", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!response.ok) {
      return res.status(500).json({ error: data });
    }

    const list = data.variants || [];

    const simplified = list.map((v) => ({
      variant_id: v.id,
      item_id: v.item_id,
      variant_name: v.variant_name,
      default_price: v.default_price ?? null,
      store_prices: v.stores || []
    }));

    res.json({ count: simplified.length, variants: simplified });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Catalog: variants + item_name
app.get("/loyverse/catalog", async (req, res) => {
  try {
    const token = process.env.LOYVERSE_TOKEN;
    if (!token) return res.status(500).json({ error: "Missing LOYVERSE_TOKEN env var" });

    async function fetchAll(urlBase) {
      let all = [];
      let cursor = null;

      while (true) {
        const url = cursor ? `${urlBase}?cursor=${encodeURIComponent(cursor)}` : urlBase;

        const r = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          }
        });

        const data = await r.json();
        if (!r.ok) {
          throw new Error(JSON.stringify(data));
        }

        // Loyverse suele devolver {items:[...], cursor:"..."} o {variants:[...], cursor:"..."}
        const list =
          data.items ||
          data.variants ||
          data.item_variants ||
          [];

        all.push(...list);

        if (!data.cursor) break;
        cursor = data.cursor;
      }

      return all;
    }

    // 1) Traer TODOS los items
    const itemsList = await fetchAll("https://api.loyverse.com/v1.0/items");
    const itemNameById = new Map(itemsList.map(i => [i.id, i.item_name]));

    // 2) Traer TODOS los variants (en tu catálogo previo usabas /variants)
    const variantsList = await fetchAll("https://api.loyverse.com/v1.0/variants");

    // 3) Enriquecer
    const enriched = variantsList.map(v => ({
      item_id: v.item_id,
      item_name: itemNameById.get(v.item_id) || null,
      variant_id: v.id,
      raw: v
    }));

    res.json({ count: enriched.length, variants: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
