// Quick DuckDB diagnostics
const { DuckDBInstance } = require('@duckdb/node-api');
(async () => {
  const dbPath = '/opt/invol/quotes.duckdb';
  console.log('Path:', dbPath);
  const fs = require('fs');
  console.log('Exists:', fs.existsSync(dbPath));
  
  const inst = await DuckDBInstance.create(dbPath);
  const conn = await inst.connect();
  
  console.log('\n=== TABLES ===');
  const tables = await conn.runAndReadAll('SHOW TABLES');
  console.log(tables.getRows());
  
  console.log('\n=== VIEWS ===');
  try {
    const views = await conn.runAndReadAll("SELECT table_name FROM information_schema.views");
    console.log(views.getRows());
  } catch(e) { console.log('views fail:', e.message); }
  
  console.log('\n=== v_stock_qfq CHECK ===');
  try {
    const r = await conn.runAndReadAll('SELECT symbol, date, close FROM v_stock_qfq ORDER BY date DESC LIMIT 1');
    console.log('OK:', r.getRows());
  } catch (e) {
    console.error('FAIL:', e.message);
  }
  
  conn.close();
  inst.close();
})().catch(e => console.error('FATAL:', e.message));
