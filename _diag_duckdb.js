// Quick DuckDB diagnostics on server
const { Database } = require('duckdb');
const db = new Database('/opt/invol/quotes.duckdb');
console.log('=== TABLES ===');
console.log(JSON.stringify(db.prepare('SHOW TABLES').all()));
console.log('=== VIEWS ===');
console.log(JSON.stringify(db.prepare("SELECT table_name FROM information_schema.views").all()));
console.log('=== v_stock_qfq CHECK ===');
try {
  const r = db.prepare('SELECT symbol, date, close FROM v_stock_qfq ORDER BY date DESC LIMIT 1').all();
  console.log('OK:', r);
} catch (e) {
  console.error('FAIL:', e.message);
}
db.close();
