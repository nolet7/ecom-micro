const express = require('express');
const morgan = require('morgan');
const { Pool } = require('pg');
const client = require('prom-client');

const PORT = process.env.SERVICE_PORT || 3002;
const pool = new Pool();

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK(price_cents>=0)
    );
  `);
}
const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'catalog_' });

const app = express();
app.use(express.json());
app.use(morgan('dev'));

app.get('/healthz', (_,res)=>res.send('ok'));
app.get('/metrics', async (_,res)=>{ res.set('Content-Type', register.contentType); res.end(await register.metrics()); });

app.post('/products', async (req,res)=>{
  const {name, price_cents} = req.body || {};
  if(!name || price_cents==null) return res.status(400).json({error:'missing'});
  const r = await pool.query('INSERT INTO products(name,price_cents) VALUES($1,$2) RETURNING *',[name,price_cents]);
  res.json(r.rows[0]);
});
app.get('/products', async (_req,res)=>{
  const r = await pool.query('SELECT * FROM products ORDER BY id');
  res.json(r.rows);
});
app.get('/products/:id', async (req,res)=>{
  const r = await pool.query('SELECT * FROM products WHERE id=$1',[req.params.id]);
  if(!r.rowCount) return res.status(404).json({error:'not found'});
  res.json(r.rows[0]);
});

init().then(()=> app.listen(PORT, ()=>console.log(`catalog up :${PORT}`)));
