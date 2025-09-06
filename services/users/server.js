const express = require('express');
const morgan = require('morgan');
const { Pool } = require('pg');
const client = require('prom-client');

const PORT = process.env.SERVICE_PORT || 3001;
const pool = new Pool();

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password TEXT NOT NULL
    );
  `);
}
const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'users_' });

const app = express();
app.use(express.json());
app.use(morgan('dev'));

app.get('/healthz', (_,res)=>res.send('ok'));
app.get('/metrics', async (_,res)=>{ res.set('Content-Type', register.contentType); res.end(await register.metrics()); });

app.post('/users', async (req,res)=>{
  const {email,name,password} = req.body || {};
  if(!email||!name||!password) return res.status(400).json({error:'missing'});
  try {
    const r = await pool.query('INSERT INTO users(email,name,password) VALUES($1,$2,$3) RETURNING id,email,name', [email,name,password]);
    res.json(r.rows[0]);
  } catch(e){ res.status(409).json({error:e.message}); }
});

app.post('/login', async (req,res)=>{
  const {email,password} = req.body || {};
  const r = await pool.query('SELECT id,email,name FROM users WHERE email=$1 AND password=$2', [email,password]);
  if(!r.rowCount) return res.status(401).json({error:'invalid'});
  // Demo token
  res.json({ token: Buffer.from(String(r.rows[0].id)).toString('base64'), user: r.rows[0] });
});

init().then(()=> app.listen(PORT, ()=>console.log(`users up :${PORT}`)));
