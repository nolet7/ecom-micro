const express = require('express');
const morgan = require('morgan');
const { Pool } = require('pg');
const client = require('prom-client');

const PORT = process.env.SERVICE_PORT || 3003;
const pool = new Pool();

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory(
      product_id INTEGER PRIMARY KEY,
      stock INTEGER NOT NULL CHECK(stock>=0)
    );
  `);
}

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'inventory_' });

const app = express();
app.use(express.json());
app.use(morgan('dev'));

app.get('/healthz', (_, res) => res.send('ok'));
app.get('/metrics', async (_, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

/** Seed or update stock */
app.post('/inventory/seed', async (req, res) => {
  const { product_id, stock } = req.body || {};
  if (!product_id || stock == null) return res.status(400).json({ error: 'missing' });
  await pool.query(`
    INSERT INTO inventory(product_id,stock)
    VALUES($1,$2)
    ON CONFLICT (product_id) DO UPDATE SET stock=EXCLUDED.stock
  `, [product_id, stock]);
  res.json({ ok: true });
});

/** List all inventory rows */
app.get('/inventory', async (_req, res) => {
  const r = await pool.query('SELECT product_id, stock FROM inventory ORDER BY product_id');
  res.json(r.rows);
});

/** Single product stock */
app.get('/inventory/:id', async (req, res) => {
  const r = await pool.query('SELECT product_id, stock FROM inventory WHERE product_id=$1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'not_found', product_id: Number(req.params.id) });
  res.json(r.rows[0]);
});

/** Check availability (no mutation) */
app.post('/inventory/check', async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items required' });
  const missing = [];
  for (const it of items) {
    const { product_id, qty } = it || {};
    if (!product_id || !qty || qty <= 0) return res.status(400).json({ error: 'bad item', item: it });
    const r = await pool.query('SELECT stock FROM inventory WHERE product_id=$1', [product_id]);
    const available = r.rowCount ? r.rows[0].stock : 0;
    if (available < qty) missing.push({ product_id, available, required: qty });
  }
  if (missing.length) return res.status(409).json({ ok: false, missing });
  res.json({ ok: true });
});

/** RESERVE stock (transactional, used by orders service) */
app.post('/inventory/reserve', async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items required' });

  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    // lock rows and ensure stock
    for (const it of items) {
      const { product_id, qty } = it || {};
      if (!product_id || !qty || qty <= 0) {
        await cx.query('ROLLBACK');
        return res.status(400).json({ error: 'bad item', item: it });
      }
      const r = await cx.query('SELECT stock FROM inventory WHERE product_id=$1 FOR UPDATE', [product_id]);
      const stock = r.rowCount ? r.rows[0].stock : 0;
      if (stock < qty) {
        await cx.query('ROLLBACK');
        return res.status(409).json({ error: 'out_of_stock', product_id, available: stock, required: qty });
      }
      if (!r.rowCount) {
        // create row if it didn't exist
        await cx.query('INSERT INTO inventory(product_id,stock) VALUES($1,$2)', [product_id, 0]);
      }
      await cx.query('UPDATE inventory SET stock=stock-$1 WHERE product_id=$2', [qty, product_id]);
    }
    await cx.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await cx.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    cx.release();
  }
});

init().then(() => app.listen(PORT, () => console.log(`inventory up :${PORT}`)));
