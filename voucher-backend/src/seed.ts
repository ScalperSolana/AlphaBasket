import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import {
  GaslessProgram,
  GaslessProgramStatus,
} from './entities/gasless-program.entity';
import { Voucher } from './entities/voucher.entity';

config();

const firstEnv = (...names: string[]): string | undefined => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
};

const basketMarketAddress =
  firstEnv('PROGRAM_ID', 'BASKET_MARKET_PROGRAM_ID', 'VITE_PROGRAM_ID') ||
  '0xa749ccd80d71637b450789e12e3d94524e9ae17877d1b59f5ddda784f89a2cba';
const freebetLedgerAddress = firstEnv(
  'FREEBET_LEDGER_ID',
  'FREEBET_LEDGER_PROGRAM_ID',
  'VITE_FREEBET_LEDGER_ID',
) || '0x2bb74834402fb7da9144d2ab91c1570e97237ad0ead1f7feb392162c3e3ad64e';

/**
 * PolyBaskets program whitelist for the voucher backend.
 *
 * Season 2 (hourly-tranche): POST /voucher accepts programs: string[] and
 * batch-registers all listed programs on a single voucher. First POST funds
 * the voucher with `HOURLY_TRANCHE_VARA` (env var, default 500) for the
 * TRANCHE_DURATION_SEC duration. Each subsequent POST after TRANCHE_INTERVAL_SEC
 * adds another tranche AND extends the duration (sliding 24h window).
 *
 * `varaToIssue` and `weight` on each row are retained for schema compatibility
 * but are no longer read by `gasless.service.ts` — the per-tranche amount is
 * applied uniformly across all programs.
 */
const optionalProgram = (
  name: string,
  address: string | undefined,
  duration = 86400,
) =>
  address
    ? [{
        name,
        address,
        weight: 1,
        duration,
        oneTime: false,
      }]
    : [];

const PROGRAMS = [
  {
    name: 'BasketMarket',
    address: basketMarketAddress,
    weight: 1,
    duration: 86400, // 24h
    oneTime: false,
  },
  {
    name: 'BetToken',
    address:
      '0x186f6cda18fea13d9fc5969eec5a379220d6726f64c1d5f4b346e89271f917bc',
    weight: 1,
    duration: 86400,
    oneTime: false,
  },
  {
    name: 'BetLane',
    address:
      '0x35848dea0ab64f283497deaff93b12fe4d17649624b2cd5149f253ef372b29dc',
    weight: 1,
    duration: 86400,
    oneTime: false,
  },
  ...optionalProgram(
    'FreebetLedger',
    freebetLedgerAddress,
  ),
];

async function seed() {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    entities: [GaslessProgram, Voucher],
    synchronize: true,
  });

  await ds.initialize();
  const repo = ds.getRepository(GaslessProgram);

  const trancheVara = Number(process.env.HOURLY_TRANCHE_VARA || '500');
  console.log(`[seed-config] BasketMarket=${basketMarketAddress}`);
  console.log(`[seed-config] FreebetLedger=${freebetLedgerAddress || 'not configured'}`);
  console.log(`[seed-config] HOURLY_TRANCHE_VARA=${trancheVara}`);

  for (const p of PROGRAMS) {
    // varaToIssue is inactive now (kept for schema compat).
    // Display value tracks trancheVara so the DB state is self-documenting.
    const varaToIssue = trancheVara;
    const existing = await repo.findOneBy({ address: p.address });

    if (existing) {
      existing.weight = p.weight;
      existing.varaToIssue = varaToIssue;
      existing.duration = p.duration;
      await repo.save(existing);
      console.log(`[update] ${p.name} ${p.address.slice(0, 12)}... (tranche=${trancheVara} VARA)`);
      continue;
    }

    await repo.save({
      name: p.name,
      address: p.address,
      varaToIssue,
      weight: p.weight,
      duration: p.duration,
      status: GaslessProgramStatus.Enabled,
      oneTime: p.oneTime,
      createdAt: new Date(),
    });
    console.log(`[seed] ${p.name} ${p.address.slice(0, 12)}... (tranche=${trancheVara} VARA)`);
  }

  console.log('Seed complete.');
  await ds.destroy();
}

seed().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
