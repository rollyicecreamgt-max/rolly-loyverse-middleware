import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing ${name} env var`);
  return val;
}

function loyverseClient() {
  const token = requireEnv("LOYVERSE_TOKEN");
  return axios.create({
    baseURL: "https://api.loyverse.com/v1.0",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });
}

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * GET /loyverse/payment_types
 */
app.get("/loyverse/payment_types", async (req, res) => {
  try {
    const api = loyverseClient();
    const r = await api.get("/payment_types");
    res.json(r.data);
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({
      error: "LOYVERSE_PAYMENT_TYPES_ERROR",
      status,
      loyverse: err?.response?.data || null,
      message: err?.message || String(err),
    });
  }
});

/**
 * GET /loyverse/catalog
 * Usa /items + /variants
 */
app.get("/loyverse/catalog", async (req, res) => {
  try {
    const api = loyverseClient();

    // 1) Items (para nombres)
    const itemsResp = await api.get("/items");
    const items = itemsResp.data?.items || [];
    const itemNameById = new Map(items.map((i) => [i.id, i.item_name]));

    // 2) Variants (para variant_id, option1_value, default_price, etc.)
    const varsResp = await api.get("/variants");
    const variants = varsResp.data?.variants || varsResp.data?.item_variants || [];

    const enriched = variants.map((v) => {
  const vid = v.id ?? v.variant_id; // <- FIX 1: tomar el que exista

  return {
    item_id: v.item_id,
    item_name: itemNameById.get(v.item_id) || null,

    // <- FIX 1: que venga arriba también
    variant_id: vid,

    raw: {
      // Para mantener tu formato previo:
      variant_id: vid,
      item_id: v.item_id,
      sku: v.sku ?? null,
      reference_variant_id: v.reference_variant_id ?? null,
      option1_value: v.option1_value ?? null,
      option2_value: v.option2_value ?? null,
      option3_value: v.option3_value ?? null,
      barcode: v.barcode ?? null,
      cost: v.cost ?? 0,
      purchase_cost: v.purchase_cost ?? null,
      default_pricing_type: v.default_pricing_type ?? v.pricing_type ?? null,
      default_price: v.default_price ?? v.price ?? 0,
      stores: v.stores ?? [],
      created_at: v.created_at ?? null,
      updated_at: v.updated_at ?? null,
      deleted_at: v.deleted_at ?? null
    }
  };
});

    res.json({ count: enriched.length, variants: enriched });
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({
      error: "LOYVERSE_CATALOG_ERROR",
      status,
      loyverse: err?.response?.data || null,
      message: err?.message || String(err),
    });
  }
});

/**
 * POST /orders
 * {
 *   note: "...",
 *   payment_type_id: "UUID",
 *   line_items: [{variant_id:"UUID", quantity:1, line_note:"..."}]
 * }
 *
 * Calcula total con /variants y crea /receipts
 */

app.post("/orders", async (req, res) => {
  console.log("✅ POST /orders hit");
  console.log("Body:", JSON.stringify(req.body, null, 2));

  try {
    const store_id = requireEnv("LOYVERSE_STORE_ID");
    const api = loyverseClient();

    const { line_items, note, payment_type_id, paid_at } = req.body || {};

    // Validaciones
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({
        error: "INVALID_PAYLOAD",
        details: "line_items must be a non-empty array",
      });
    }

    if (!payment_type_id || typeof payment_type_id !== "string") {
      return res.status(400).json({
        error: "INVALID_PAYLOAD",
        details: "payment_type_id is required (string)",
      });
    }

    for (const [i, li] of line_items.entries()) {
      if (!li?.variant_id || typeof li.variant_id !== "string") {
        return res.status(400).json({ error: "INVALID_LINE_ITEMS", details: `line_items[${i}].variant_id required` });
      }
const qty = Number(li.quantity);
if (!Number.isFinite(qty) || qty <= 0) {
  return res.status(400).json({
    error: "INVALID_LINE_ITEMS",
    details: `line_items[${i}].quantity must be a number > 0`,
  });
}
li.quantity = qty;

    // 1) Traer variants para precios
    const varsResp = await api.get("/variants");
    const variants = varsResp.data?.variants || varsResp.data?.item_variants || [];

    const priceByVariantId = new Map(
  variants
    .map((v) => {
      const vid = v?.id || v?.variant_id || v?.raw?.variant_id;
      const price =
        v?.default_price ??
        v?.price ??
        v?.raw?.default_price ??
        v?.raw?.stores?.[0]?.price ??
        0;

      return [vid, Number(price)];
    })
    .filter(([vid]) => !!vid)
);
    
console.log("priceByVariantId sample:", Array.from(priceByVariantId.entries()).slice(0, 5));

    // 2) Calcular total
    let total = 0;
    for (const li of line_items) {
      const price = priceByVariantId.get(li.variant_id);
      if (price === undefined) {
        return res.status(400).json({
          error: "UNKNOWN_VARIANT_ID",
          details: `variant_id not found in Loyverse: ${li.variant_id}`,
        });
      }
      total += price * li.quantity;
    }

    // 3) Crear receipt
    const payload = {
      store_id,
      note: note || "Pedido GPT - Mostrador",
      line_items: line_items.map((li) => ({
        variant_id: li.variant_id,
        quantity: li.quantity,
        line_note: li.line_note || "",
      })),
      payments: [
        {
          payment_type_id,
          money_amount: Number(total),
          paid_at: paid_at || new Date().toISOString(),
        },
      ],
    };

    const receiptResp = await api.post("/receipts", payload);

// log de auditoría
console.log("🧾 Receipt created in Loyverse:", {
  receipt_number: receiptResp.data?.receipt_number,
  receipt_id: receiptResp.data?.id,
  total: total,
  payment_type_id: payment_type_id,
});

    return res.status(200).json({
      ok: true,
      receipt: receiptResp.data,
      computed_total: total,
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({
      error: "LOYVERSE_ORDER_ERROR",
      status,
      loyverse: err?.response?.data || null,
      message: err?.message || String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Rolly middleware running on port ${PORT}`);
});
