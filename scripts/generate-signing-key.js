// Site-wide Ed25519 signing key — generation utility + build-time
// publisher of the Web Bot Auth public JWKS.
//
// One key, two purposes:
//   - Web Bot Auth (RFC 9421 + 9421bis): the public JWK is baked into
//     /.well-known/http-message-signatures-directory at build time.
//   - OAuth: /oauth/token signs EdDSA JWS access tokens with the same
//     key at runtime (see functions/oauth/[[path]].js); /oauth/jwks.json
//     publishes the same public JWK.
//
// Reads the private key from SIGNING_PRIVATE_KEY (Ed25519 PEM). When
// set, derives the public key, computes a JWK Thumbprint (RFC 7638)
// for `kid`, and emits a JWKS pointing at it. When unset, emits an
// empty `{ "keys": [] }` document (still valid JSON, scores partial
// credit; OAuth tokens fall back to HS256 at runtime).
//
// Generate a fresh keypair locally with:
//   node scripts/generate-signing-key.js --new-key
//
// Then paste the printed PEM into:
//   1. GitHub Actions secret named SIGNING_PRIVATE_KEY (so CI bakes
//      the public JWK into the static well-known file).
//   2. Cloudflare Pages env var named SIGNING_PRIVATE_KEY (so the
//      runtime function can sign tokens).

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "crypto";
import { mkdirSync, writeFileSync } from "fs";

const KEY_LIFETIME_DAYS = 90;
const OUT_PATH = "public/.well-known/http-message-signatures-directory";

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Print a fresh keypair (PEM private + base64url public) and exit. Use
// when bootstrapping a new repo's SIGNING_PRIVATE_KEY secret.
if (process.argv.includes("--new-key")) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const rawPub = publicKey.export({ type: "spki", format: "der" }).slice(-32);
  console.log("# === Site signing key — fresh Ed25519 keypair ===");
  console.log("# Private key (PEM) — paste this into the SIGNING_PRIVATE_KEY GitHub secret");
  console.log("# (also used by /oauth/token to sign EdDSA access tokens):");
  console.log("#");
  console.log(pem.trimEnd());
  console.log("#");
  console.log("# Public key (base64url, 32 bytes):", base64url(rawPub));
  console.log("# Thumbprint (kid):", base64url(createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: base64url(rawPub) })).digest()));
  console.log("#");
  console.log("# Once the secret is set, the next CI build publishes the public");
  console.log("# key at /.well-known/http-message-signatures-directory and");
  console.log("# /oauth/jwks.json. /oauth/token starts signing tokens with EdDSA.");
  process.exit(0);
}

mkdirSync("public/.well-known", { recursive: true });

const privPem = process.env.SIGNING_PRIVATE_KEY || process.env.WEB_BOT_AUTH_PRIVATE_KEY;
const keys = [];

if (privPem && privPem.trim()) {
  try {
    const privateKey = createPrivateKey(privPem);
    const publicKey = createPublicKey(privateKey);
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error(`Expected Ed25519 key, got ${publicKey.asymmetricKeyType}`);
    }
    // SPKI DER for Ed25519 is 12 bytes of header + 32 bytes of raw key.
    const rawPub = publicKey.export({ type: "spki", format: "der" }).slice(-32);
    const xB64 = base64url(rawPub);
    const jwkForThumbprint = JSON.stringify({ crv: "Ed25519", kty: "OKP", x: xB64 });
    const kid = base64url(createHash("sha256").update(jwkForThumbprint).digest());
    const nowSec = Math.floor(Date.now() / 1000);
    keys.push({
      kty: "OKP",
      crv: "Ed25519",
      kid,
      x: xB64,
      nbf: nowSec,
      exp: nowSec + KEY_LIFETIME_DAYS * 86400,
      use: "sig",
      alg: "EdDSA",
    });
    console.log(`Generated ${OUT_PATH} with 1 Ed25519 key (kid=${kid.slice(0, 12)}…)`);
  } catch (e) {
    console.error(`SIGNING_PRIVATE_KEY present but invalid: ${e.message}`);
    console.error("Emitting empty keys[] — fix the secret and rebuild.");
  }
} else {
  console.log(`Generated ${OUT_PATH} with empty keys[] (set SIGNING_PRIVATE_KEY to publish a key).`);
}

writeFileSync(OUT_PATH, JSON.stringify({ keys }, null, 2) + "\n");
