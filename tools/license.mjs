#!/usr/bin/env node
// FrameCraft license tool. Signs Pro keys offline with an ECDSA P-256 key.
// The private key lives in ~/.framecraft/private.jwk and is never committed.
//
//   node tools/license.mjs init                 create keypair, print public JWK for js/config.js
//   node tools/license.mjs issue <email> [days] issue a key (default 31 days; 0 = lifetime)
//   node tools/license.mjs verify <key>         check a key against the local keypair
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.framecraft');
const KEY_FILE = join(DIR, 'private.jwk');
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function loadPrivate() {
  if (!existsSync(KEY_FILE)) {
    console.error(`No key at ${KEY_FILE}. Run: node tools/license.mjs init`);
    process.exit(1);
  }
  return createPrivateKey({ key: JSON.parse(readFileSync(KEY_FILE, 'utf8')), format: 'jwk' });
}

function publicJwk(priv) {
  const { kty, crv, x, y } = createPublicKey(priv).export({ format: 'jwk' });
  return { kty, crv, x, y };
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'init') {
  if (existsSync(KEY_FILE)) {
    console.error(`Key already exists at ${KEY_FILE}; refusing to overwrite (old licenses would break).`);
    console.log(JSON.stringify(publicJwk(loadPrivate())));
    process.exit(1);
  }
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(KEY_FILE, JSON.stringify(privateKey.export({ format: 'jwk' })), { mode: 0o600 });
  console.log('Private key saved to', KEY_FILE, '(back it up, never share it)');
  console.log('Public JWK for js/config.js:');
  console.log(JSON.stringify(publicJwk(privateKey)));
} else if (cmd === 'issue') {
  const [email, daysArg = '31'] = args;
  if (!email) { console.error('Usage: issue <email> [days]'); process.exit(1); }
  const days = Number(daysArg);
  const payload = { e: email, i: Date.now(), x: days > 0 ? Date.now() + days * 86400000 : 0, p: 'pro' };
  const body = b64u(JSON.stringify(payload));
  const sig = sign('sha256', Buffer.from(body), { key: loadPrivate(), dsaEncoding: 'ieee-p1363' });
  console.log(`FC1.${body}.${b64u(sig)}`);
} else if (cmd === 'verify') {
  const [key = ''] = args;
  const [ver, body, sig] = key.trim().split('.');
  const priv = loadPrivate();
  const ok = ver === 'FC1' && !!body && !!sig && verify('sha256', Buffer.from(body),
    { key: createPublicKey(priv), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  console.log(ok ? 'VALID' : 'INVALID', ok ? JSON.parse(Buffer.from(body, 'base64url')) : '');
  process.exit(ok ? 0 : 1);
} else {
  console.log('Commands: init | issue <email> [days] | verify <key>');
}
