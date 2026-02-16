import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LOYVERSE_TOKEN = process.env.LOYVERSE_TOKEN;

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Create order
app.post("/orders", async (req, res) => {
  try {
    const store_id = process.env.LOYVERSE_STORE_ID;
    const token = process.env.LOYVERSE_TOKEN;

    if (!store_id) return res.status(500).json({ error: "Missing LOYVERSE_STORE_ID env var" });
    if (!token) return res.status(500).json({ error: "Missing LOYVERSE_TOKEN env var" });

    const { line_items, note, payments } = req.body || {};

    // Validación mínima
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({
        error: "Invalid payload",
        details: "line_items must be a non-empty array",
        example: {
          line_items: [
            { variant_id: "UUID", quantity: 1, line_note: "Helado Natural de Fresa - Normal" }
          ],
          note: "Pedido GPT - Mostrador"
        }
      });
    }
    
if (!Array.isArray(payments) || payments.length === 0) {
  return res.status(400).json({
    error: "Invalid payload",
    details: "payments must be a non-empty array",
    example: {
      line_items: [{ variant_id: "UUID", quantity: 1, line_note: "Helado Natural - Vainilla - Normal" }],
      payments: [{ payment_type_id: "UUID", money_amount: 27.00 }],
      note: "Pedido GPT - Mostrador"
    }
  });
}

    for (const [i, li] of line_items.entries()) {
      if (!li?.variant_id || typeof li.variant_id !== "string") {
        return res.status(400).json({ error: "Invalid line_items", details: `line_items[${i}].variant_id required` });
      }
      if (!li?.quantity || typeof li.quantity !== "number" || li.quantity <= 0) {
        return res.status(400).json({ error: "Invalid line_items", details: `line_items[${i}].quantity must be > 0 (number)` });
      }
    }

    // Payload a Loyverse (receipt)
    const payload = {
  store_id,
  note: note || "Pedido GPT - Mostrador",
  line_items: line_items.map((li) => ({
    variant_id: li.variant_id,
    quantity: li.quantity,
    // Si Loyverse ignora line_note, igual lo dejamos para ticket/registro.
    line_note: li.line_note || ""
  })),
  payments: payments.map((p) => ({
    payment_type_id: p.payment_type_id,
    money_amount: Number(p.money_amount),
    paid_at: p.paid_at || new Date().toISOString()
  }))
};

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
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

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

app.listen(PORT, () => {
  console.log(`Rolly middleware running on port ${PORT}`);
});
app.get("/loyverse/items", async (req, res) => {
  try {
    const response = await fetch("https://api.loyverse.com/v1.0/items", {
      headers: {
        Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({ error: text });
    }

    const data = await response.json();

    const simplified = data.items.map(item => ({
      item_id: item.id,
      name: item.item_name,
      variants: item.variants.map(v => ({
        variant_id: v.id,
        variant_name: v.variant_name,
        price: v.price
      }))
    }));

    res.json(simplified);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get("/loyverse/variants", async (req, res) => {
  try {
    const response = await fetch("https://api.loyverse.com/v1.0/variants", {
      headers: {
        Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    const data = await response.json();

    // Si Loyverse devuelve error, lo devolvemos tal cual para ver el detalle
    if (!response.ok) {
      return res.status(500).json({ error: data });
    }

    // La lista puede venir con distintas llaves
    const list =
      data.variants ||
      data.item_variants ||
      data.items ||
      data.data ||
      [];

    const simplified = list.map(v => ({
      variant_id: v.id,
      item_id: v.item_id,
      variant_name: v.variant_name,
      price: v.price
    }));

    res.json({
      count: simplified.length,
      variants: simplified
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get("/loyverse/catalog", async (req, res) => {
  try {
    // 1) Traer items (para obtener nombre por item_id)
    const itemsResp = await fetch("https://api.loyverse.com/v1.0/items", {
      headers: {
        Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    const itemsData = await itemsResp.json();
    if (!itemsResp.ok) return res.status(500).json({ error: itemsData });

    // 2) Crear mapa item_id -> item_name
    const itemsList = itemsData.items || [];
    const itemNameById = new Map(itemsList.map(i => [i.id, i.item_name]));

    // 3) Traer variants (para obtener variant_id por item_id)
    const varResp = await fetch("https://api.loyverse.com/v1.0/variants", {
      headers: {
        Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    const varData = await varResp.json();
    if (!varResp.ok) return res.status(500).json({ error: varData });

    const variantsList = varData.variants || [];

    // 4) Enriquecer: item_name + variant_id
    const enriched = variantsList.map(v => ({
      item_id: v.item_id,
      item_name: itemNameById.get(v.item_id) || null,
      variant_id: v.id,
      // dejamos el objeto completo por si Loyverse trae más campos (ej. option values)
      raw: v
    }));

    res.json({ count: enriched.length, variants: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
