const express = require('express');
const morgan = require('morgan');
const { Pool } = require('pg');
const axios = require('axios');
const client = require('prom-client');
const crypto = require('crypto');

const PORT = process.env.SERVICE_PORT || 3004;
const CATALOG_URL = process.env.CATALOG_URL;
const INVENTORY_URL = process.env.INVENTORY_URL;
const PAYMENTS_URL = process.env.PAYMENTS_URL;

const pool = new Pool();

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders(
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items(
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL,
      qty INTEGER NOT NULL CHECK(qty>0),
      price_cents INTEGER NOT NULL CHECK(price_cents>=0)
    );
  `);
}
const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'orders_' });

const app = express();
app.use(express.json());
app.use(morgan('dev'));

app.get('/healthz', (_,res)=>res.send('ok'));
app.get('/metrics', async (_,res)=>{ res.set('Content-Type', register.contentType); res.end(await register.metrics()); });

async function priceLookup(items){
  let total = 0;
  const priced = [];
  for(const it of items){
    const { data: p } = await axios.get(`${CATALOG_URL}/products/${it.product_id}`);
    const price = p.price_cents;
    total += price * it.qty;
    priced.push({ ...it, price_cents: price });
  }
  return { priced, total };
}

app.post('/orders', async (req,res)=>{
  try{
    const { user_id, items, idempotency_key } = req.body || {};
    if(!user_id || !Array.isArray(items) || !items.length) return res.status(400).json({error:'bad request'});
    const idem = idempotency_key || crypto.randomUUID();

    // idempotency check
    const existed = await pool.query('SELECT * FROM orders WHERE idempotency_key=$1',[idem]);
    if(existed.rowCount) return res.json(existed.rows[0]);

    // price lookup from catalog
    const { priced, total } = await priceLookup(items);

    // create order (PENDING)
    const clientPg = await pool.connect();
    try{
      await clientPg.query('BEGIN');
      const r = await clientPg.query(
        'INSERT INTO orders(user_id,amount_cents,status,idempotency_key) VALUES($1,$2,$3,$4) RETURNING *',
        [user_id, total, 'PENDING', idem]
      );
      const order = r.rows[0];
      for(const it of priced){
        await clientPg.query(
          'INSERT INTO order_items(order_id,product_id,qty,price_cents) VALUES($1,$2,$3,$4)',
          [order.id, it.product_id, it.qty, it.price_cents]
        );
      }
      await clientPg.query('COMMIT');

      // request payment
      const pay = await axios.post(`${PAYMENTS_URL}/payments`, { order_id: order.id, amount_cents: total, idempotency_key: idem });
      if(pay.data.status !== 'SUCCEEDED'){
        await pool.query('UPDATE orders SET status=$1 WHERE id=$2',['CANCELED',order.id]);
        return res.status(402).json({error:'payment_failed', order_id: order.id});
      }

      // reserve inventory (transactional in inventory service)
      const inv = await axios.post(`${INVENTORY_URL}/inventory/reserve`, {
        items: items.map(i=>({product_id:i.product_id, qty:i.qty}))
      }).catch(e=>({status:e.response?.status||500, data:e.response?.data||{}}));

      if(inv.status && inv.status !== 200){
        // compensate: refund payment
        await axios.post(`${PAYMENTS_URL}/refunds`, { idempotency_key: idem }).catch(()=>{});
        await pool.query('UPDATE orders SET status=$1 WHERE id=$2',['CANCELED',order.id]);
        return res.status(409).json({error:'out_of_stock', order_id: order.id});
      }

      // success
      const r2 = await pool.query('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *',['CONFIRMED',order.id]);
      return res.json(r2.rows[0]);
    } catch(e){ await clientPg.query('ROLLBACK'); throw e; }
    finally { clientPg.release(); }

  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/orders/:id', async (req,res)=>{
  const r = await pool.query('SELECT * FROM orders WHERE id=$1',[req.params.id]);
  if(!r.rowCount) return res.status(404).json({error:'not found'});
  const items = await pool.query('SELECT product_id,qty,price_cents FROM order_items WHERE order_id=$1',[req.params.id]);
  res.json({...r.rows[0], items: items.rows});
});

init().then(()=> app.listen(PORT, ()=>console.log(`orders up :${PORT}`)));
