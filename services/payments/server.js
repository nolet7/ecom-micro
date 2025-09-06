const express = require('express');
const morgan = require('morgan');
const { Pool } = require('pg');
const client = require('prom-client');

const PORT = process.env.SERVICE_PORT || 3005;
const MODE = process.env.PAYMENTS_MODE || 'random'; // always_success | always_fail | random
const pool = new Pool();

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments(
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
      status TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'payments_' });

const app = express();
app.use(express.json());
app.use(morgan('dev'));

app.get('/healthz', (_,res)=>res.send('ok'));
app.get('/metrics', async (_,res)=>{ res.set('Content-Type', register.contentType); res.end(await register.metrics()); });

function decideStatus(){
  if(MODE==='always_success') return 'SUCCEEDED';
  if(MODE==='always_fail') return 'FAILED';
  return Math.random()<0.8 ? 'SUCCEEDED' : 'FAILED'; // random default
}

app.post('/payments', async (req,res)=>{
  const { order_id, amount_cents, idempotency_key } = req.body || {};
  if(!order_id || amount_cents==null || !idempotency_key) return res.status(400).json({error:'missing'});
  const existing = await pool.query('SELECT * FROM payments WHERE idempotency_key=$1',[idempotency_key]);
  if(existing.rowCount) return res.json(existing.rows[0]);
  const status = decideStatus();
  const r = await pool.query(
    'INSERT INTO payments(order_id,amount_cents,status,idempotency_key) VALUES($1,$2,$3,$4) RETURNING *',
    [order_id, amount_cents, status, idempotency_key]
  );
  res.json(r.rows[0]);
});

app.post('/refunds', async (req,res)=>{
  const { idempotency_key } = req.body || {};
  if(!idempotency_key) return res.status(400).json({error:'missing idempotency_key'});
  const r = await pool.query('UPDATE payments SET status=$1 WHERE idempotency_key=$2 RETURNING *',['REFUNDED',idempotency_key]);
  if(!r.rowCount) return res.status(404).json({error:'payment not found'});
  res.json(r.rows[0]);
});

init().then(()=> app.listen(PORT, ()=>console.log(`payments up :${PORT} mode=${MODE}`)));
