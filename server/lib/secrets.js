'use strict';

const crypto = require('node:crypto');

// AES-256-GCM encryption for secrets stored in the database, keyed by the
// SETTINGS_SECRET environment variable. A database dump alone does not
// reveal the secrets; changing SETTINGS_SECRET makes stored ones unreadable.
function keyFrom(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encrypt(secret, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(secret, box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
