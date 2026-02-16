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
    const order = req.body;

    if (!order || !order.items || order.items.length === 0) {
      return res.status(400).json({ error: "Order inválida" });
    }

    const response = await axios.post(
      "https://api.loyverse.com/v1.0/receipts",
      {
        line_items: order.items,
        note: order.note || "Pedido generado por GPT"
      },
      {
        headers: {
          Authorization: `Bearer ${LOYVERSE_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({
      success: true,
      receipt_id: response.data.id,
      receipt_number: response.data.receipt_number
    });

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: "Error creando receipt en Loyverse" });
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
