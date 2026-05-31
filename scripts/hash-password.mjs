import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";

const algorithm = "pbkdf2-sha256";
const iterations = 100_000;
const saltBytes = 16;
const hashBytes = 32;

const password = process.argv[2] ?? readFileSync(0, "utf8").trim();

if (!password) {
  console.error("Usage: npm run password:hash -- <password>");
  console.error("Or pipe the password on stdin.");
  process.exit(1);
}

const salt = webcrypto.getRandomValues(new Uint8Array(saltBytes));
const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = await webcrypto.subtle.deriveBits(
  { name: "PBKDF2", hash: "SHA-256", salt, iterations },
  key,
  hashBytes * 8
);

console.log(`${algorithm}$${iterations}$${base64Url(salt)}$${base64Url(new Uint8Array(bits))}`);

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
