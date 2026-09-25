'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
// N=2^15, r=8, p=1: about 32 MiB and tens of milliseconds per hash.
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [algo, N, r, p, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem,
  });
  return crypto.timingSafeEqual(key, expected);
}

// Used to spend comparable time when the account does not exist.
let dummyHash;
async function burnTime(password) {
  dummyHash = dummyHash || (await hashPassword('not-a-real-password'));
  await verifyPassword(password, dummyHash);
  return false;
}

module.exports = { hashPassword, verifyPassword, burnTime };
