/**
 * The account CA for LAN device certificates.
 *
 * A LAN peer proves two things before a socket is useful: the account signed
 * its device keys, and it still holds the matching private keys (Noise does the
 * second). The relay only does the first. It never stores a device secret, and
 * the certificate is a signed JSON body rather than X.509 so both sides can use
 * the same canonical bytes without a PKI dependency.
 *
 * The CA private key is supplied by the operator (base64 PKCS#8 DER). A relay
 * without one answers 503 rather than generating a new CA on every boot, which
 * would silently invalidate every certificate already handed out.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto'

export interface LanCA {
  readonly privateKey: KeyObject
  readonly publicKey: KeyObject
}

export interface LanCertificate {
  readonly body: Record<string, unknown>
  readonly signature: string
  /** Base64 raw Ed25519 public key, so a verifier needs no X.509 parser. */
  readonly caPublicKey: string
}

/** Why a certificate request was refused, in the API's error language. */
export class LanCertificateError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** How long one certificate is valid. The plan's ceiling is 90 days. */
const CERTIFICATE_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * Read the CA from `MZ_LAN_CA_KEY` (base64 PKCS#8 DER), or return null.
 *
 * Absent is a supported deployment: WAN keeps working and LAN certificates are
 * unavailable until an operator configures a stable CA.
 */
export function lanCaFromEnvironment(environment: NodeJS.ProcessEnv = process.env): LanCA | null {
  const encoded = environment['MZ_LAN_CA_KEY']
  if (encoded === undefined || encoded.trim() === '') return null
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(encoded.trim(), 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    return { privateKey, publicKey: createPublicKey(privateKey) }
  } catch {
    return null
  }
}

/** Generate a CA for tests and local development. */
export function generateLanCA(): LanCA {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey }
}

/** Decode one 32-byte base64 public key, or throw an API-shaped error. */
function publicKeyOf(value: unknown, field: string): Buffer {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LanCertificateError('INVALID_INPUT', `${field} is required`, 400)
  }
  let bytes: Buffer
  try {
    bytes = Buffer.from(value, 'base64')
  } catch {
    throw new LanCertificateError('INVALID_INPUT', `${field} is not base64`, 400)
  }
  if (bytes.length !== 32) {
    throw new LanCertificateError('INVALID_INPUT', `${field} must be 32 bytes`, 400)
  }
  return bytes
}

/**
 * Sign one device certificate.
 *
 * The body's field order is the canonical order: both the Rust verifier and
 * this issuer serialise the object with the same keys in the same order.
 */
export function issueLanCertificate(
  ca: LanCA,
  accountId: string,
  deviceId: string,
  ed25519Public: unknown,
  x25519Public: unknown,
  now: number,
): LanCertificate {
  const ed = publicKeyOf(ed25519Public, 'ed25519Public')
  const x = publicKeyOf(x25519Public, 'x25519Public')
  const body = {
    v: 1,
    accountId,
    deviceId,
    ed25519Public: ed.toString('base64'),
    x25519Public: x.toString('base64'),
    issuedAt: now,
    expiresAt: now + CERTIFICATE_TTL_MS,
  }
  const signature = sign(null, Buffer.from(JSON.stringify(body), 'utf8'), ca.privateKey)
  const spki = ca.publicKey.export({ format: 'der', type: 'spki' })
  return {
    body,
    signature: signature.toString('base64'),
    caPublicKey: spki.subarray(spki.length - 32).toString('base64'),
  }
}
