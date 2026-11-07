/* Opt-in local CA for the HTTPS proxy (docs/agent-sdk.md §1 option C, §3.3).

   Without it the proxy only sees CONNECT host names: HTTPS can be sent
   directly or blocked, never through anon-rpc. With it, the operator installs
   Canary's CA in the agent's runtime (NODE_EXTRA_CA_CERTS, REQUESTS_CA_BUNDLE,
   SSL_CERT_FILE), the proxy terminates TLS with a per-host certificate, and
   every request gets the full policy with bodies visible, including `anon`
   routing. Same model as a corporate egress proxy; off by default.

   The CA key never leaves `dir` (written 0600). Upstream TLS is still
   verified normally on the way out. */

import { createSecureContext, rootCertificates, type SecureContext } from "node:tls";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
import forge from "node-forge";

const { pki, md } = forge;

export type MitmConfig = {
  /** where ca.pem / ca.key / bundle.pem live (default ~/.canary/ca) */
  dir?: string;
  /** hosts never intercepted (certificate-pinned clients): tunnelled as before, bodies not inspected */
  passthrough?: string[];
};

export type CaFiles = { dir: string; cert: string; key: string; bundle: string };

const exists = (p: string) => stat(p).then(() => true, () => false);
const serial = () => forge.util.bytesToHex(forge.random.getBytesSync(16)).replace(/^[89a-f]/, "1");

export const defaultCaDir = () => join(homedir(), ".canary", "ca");

/** Load the CA from `dir`, or create it (RSA 2048, 2 years) on first use. */
export async function loadOrCreateCa(dir = defaultCaDir()): Promise<{ files: CaFiles; certPem: string; keyPem: string; created: boolean }> {
  const files = { dir, cert: join(dir, "ca.pem"), key: join(dir, "ca.key"), bundle: join(dir, "bundle.pem") };
  if ((await exists(files.cert)) && (await exists(files.key))) {
    const certPem = await readFile(files.cert, "utf8");
    if (!(await exists(files.bundle))) await writeBundle(files.bundle, certPem);
    return { files, certPem, keyPem: await readFile(files.key, "utf8"), created: false };
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 2 * 365 * 86400_000);
  const subject = [{ name: "commonName", value: `Canary local CA (${hostname()})` }, { name: "organizationName", value: "Canary gateway, local only" }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, md.sha256.create());
  const certPem = pki.certificateToPem(cert);
  const keyPem = pki.privateKeyToPem(keys.privateKey);
  await writeFile(files.key, keyPem, { mode: 0o600 });
  await chmod(files.key, 0o600);
  await writeFile(files.cert, certPem, { mode: 0o644 });
  await writeBundle(files.bundle, certPem);
  return { files, certPem, keyPem, created: true };
}

/** Public roots + Canary's CA: for clients whose CA setting replaces the default set (Python requests, curl). */
async function writeBundle(path: string, caPem: string) {
  await writeFile(path, [...rootCertificates, caPem].join("\n"), { mode: 0o644 });
}

/** Mints and caches a certificate per host, all sharing one leaf key. */
export class Mitm {
  private ca: forge.pki.Certificate;
  private caKey: forge.pki.rsa.PrivateKey;
  private leafKeys = pki.rsa.generateKeyPair(2048);
  private leafKeyPem: string;
  private cache = new Map<string, SecureContext>();
  readonly passthrough: Set<string>;

  constructor(certPem: string, keyPem: string, passthrough: string[] = []) {
    this.ca = pki.certificateFromPem(certPem);
    this.caKey = pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
    this.leafKeyPem = pki.privateKeyToPem(this.leafKeys.privateKey);
    this.passthrough = new Set(passthrough.map((h) => h.toLowerCase()));
  }

  contextFor(host: string): SecureContext {
    const h = host.toLowerCase();
    const hit = this.cache.get(h);
    if (hit) return hit;
    const cert = pki.createCertificate();
    cert.publicKey = this.leafKeys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 397 * 86400_000);
    cert.setSubject([{ name: "commonName", value: h }]);
    cert.setIssuer(this.ca.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [isIP(h) ? { type: 7, ip: h } : { type: 2, value: h }] },
    ]);
    cert.sign(this.caKey, md.sha256.create());
    const ctx = createSecureContext({ key: this.leafKeyPem, cert: pki.certificateToPem(cert) });
    this.cache.set(h, ctx);
    return ctx;
  }
}
