/** Crea usuarios de prueba con saldo. Uso: npm run seed */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { usersRepo } from '../src/repositories/reference.repo.js';
import { toCents } from '../src/domain/money.js';

const USERS = [
  { id: 1, username: 'alice', cash: 1_000_000 },
  { id: 2, username: 'bob', cash: 1_000_000 },
  { id: 3, username: 'carol', cash: 500_000 },
  { id: 4, username: 'dave', cash: 500_000 },
];

for (const u of USERS) {
  await usersRepo.create({ id: u.id, username: u.username, cashBalanceCents: toCents(u.cash) });
  console.log(`usuario ${u.id} (${u.username}) con saldo ${u.cash}`);
}
await pool.end();
console.log('seed completo.');
