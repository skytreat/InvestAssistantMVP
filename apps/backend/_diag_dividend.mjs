// Direct importDividendEvents diagnostic
import { importDividendEvents } from './src/services/exDividendSync.js';
import { queryDuckDB } from './src/db/duckdb.js';

const tradeDate = '2026-10-15';
console.log('Trade date:', tradeDate);

// First check what DuckDB has for raw_gbbq
try {
  const rows = await queryDuckDB('SELECT * FROM raw_gbbq WHERE trade_date = ? LIMIT 5', [tradeDate]);
  console.log('raw_gbbq rows:', rows.length, rows);
} catch(e) { console.error('DuckDB query fail:', e.message); }

// Now run import
try {
  const result = await importDividendEvents(tradeDate);
  console.log('result:', JSON.stringify(result));
} catch(e) { console.error('importDividendEvents throw:', e.message, e.stack); }
