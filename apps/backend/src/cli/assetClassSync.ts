/**
 * asset_class 初判 CLI（默认 dry-run，只读打开业务库；`--execute` 才落库且先自动备份）
 *
 * 用法（在 apps/backend 下）：
 *   npx tsx src/cli/assetClassSync.ts                      # dry-run，报告写 %TEMP%
 *   npx tsx src/cli/assetClassSync.ts --report <路径>       # dry-run + 指定报告路径
 *   npx tsx src/cli/assetClassSync.ts --execute             # 真落库（ADR-026：新标的插入 / rule-default 可改判 / manual 不覆盖）
 *   npx tsx src/cli/assetClassSync.ts --all                 # 全量审计业务层标的（默认只看候选）
 *
 * 环境变量：`SQLITE_DB_PATH`（默认 data/business.db）、`DUCKDB_PATH`（默认 data/quotes.duckdb）
 * 安全：dry-run 用 `readonly: true` 打开 **且不执行任何 DDL**（不经 ConfigStore），
 *       因此对真实库零写入；execute 前先 `db.backup()` 全库热备份并打印备份路径。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ASSET_CLASS_SYNC_ENV,
  renderSyncReport,
  selectClassifyCandidates,
  syncAssetClass,
} from '../services/assetClassSync.js';

function argOf(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const dbPath = process.env.SQLITE_DB_PATH ?? path.resolve('data', 'business.db');
  const duckdbPath = process.env.DUCKDB_PATH ?? path.resolve('data', 'quotes.duckdb');
  if (!fs.existsSync(dbPath)) {
    console.error(`业务库不存在：${dbPath}`);
    process.exit(1);
  }

  if (execute && process.env[ASSET_CLASS_SYNC_ENV] === 'off') {
    console.error(`${ASSET_CLASS_SYNC_ENV}=off 与 --execute 冲突，已中止（未写库）`);
    process.exit(1);
  }

  // dry-run：readonly ⇒ 零写入；execute：需可写连接
  const db = new Database(dbPath, execute ? {} : { readonly: true, fileMustExist: true });

  let backupPath: string | null = null;
  try {
    if (execute) {
      const stamp = new Date().toLocaleString('sv-SE', { hour12: false }).replace(/[-: ]/g, '').slice(0, 14);
      backupPath = `${dbPath}.pre-asset-class-${stamp}`;
      await db.backup(backupPath);
      console.log(`[backup] 已备份业务库 → ${backupPath}`);
    }

    const mode = execute ? 'execute' : 'dry-run';
    // 默认只处理「还没定论」的候选（增量）；--all 才全量审计业务层标的
    const scope = argv.includes('--all') ? undefined : selectClassifyCandidates(db).map((c) => c.symbol);
    const result = await syncAssetClass(db, mode, undefined, scope);

    const generatedAt = new Date().toLocaleString('sv-SE', { hour12: false });
    const report =
      argOf(argv, '--report') ??
      path.join(os.tmpdir(), `asset-class-${mode}-${generatedAt.replace(/[-: ]/g, '')}.md`);
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, renderSyncReport(result, { dbPath, duckdbPath, generatedAt }), 'utf8');

    const cash = result.rows.filter((r) => r.nextClass === 'cash');
    console.log(`[mode] ${mode}`);
    console.log(
      `[symbols] ${result.rows.length}（当前未分类 ${result.rows.filter((r) => r.currentClass === null).length}）`,
    );
    console.log(`[cash] ${cash.length}`);
    console.log(`[written] ${result.writtenCount}`);
    console.log(`[unclassifiable] ${result.unclassifiable.length}`);
    console.log('[distribution]');
    for (const d of result.distribution) console.log(`  ${d.assetClass} / ${d.ruleHit}: ${d.count}`);
    if (cash.length > 0) {
      console.log('[cash symbols]');
      for (const r of cash.slice(0, 30)) {
        console.log(`  ${r.symbol} ${r.name ?? '-'} → cash via ${r.nextRuleHit}（${r.basis}）`);
      }
      if (cash.length > 30) console.log(`  …共 ${cash.length} 个，完整清单见报告`);
    }
    console.log(`[report] ${report}`);
    if (backupPath) console.log(`[backup] ${backupPath}`);
  } finally {
    db.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('asset_class 初判失败：', err);
  process.exit(1);
});
