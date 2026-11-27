/**
 * Compile-time regression test (type-checked by `pnpm typecheck` through tsconfig.tests.json): the
 * documented `new LucidTelescopeStore(db)` compiles with a real Lucid `Database`, connection and
 * transaction.
 */
import type { Database } from '@adonisjs/lucid/database';
import type { TransactionClientContract } from '@adonisjs/lucid/types/database';
import { LucidTelescopeStore } from '../../src/stores/lucid.js';

declare const db: Database;
declare const trx: TransactionClientContract;

new LucidTelescopeStore(db);
new LucidTelescopeStore(db, { tableName: 'tscope', autoCreateTable: true });
new LucidTelescopeStore(db.connection('pg'), { schema: 'shop', readOnly: true });
new LucidTelescopeStore(trx);
