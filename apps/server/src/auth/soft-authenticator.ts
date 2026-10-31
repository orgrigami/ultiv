/**
 * A software passkey authenticator for tests: an ES256 key pair, "none"
 * attestation, and assertions signed the way a platform authenticator signs
 * them. Enough to drive the real register and sign-in routes end to end.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array | string): Buffer => createHash("sha256").update(bytes).digest();

/** The small CBOR subset WebAuthn needs: ints, byte and text strings, maps. */
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
const head = (major: number, length: number): Buffer => {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
};
const cbor = (value: Cbor): Buffer => {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, text.length), text]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const parts = [head(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return Buffer.concat(parts);
};

const counterBytes = (n: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(n);
  return out;
};

export const softAuthenticator = (rpId: string, origin: string) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(16);
  let counter = 0;
  const clientData = (type: string, challenge: string): Buffer =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64url(credentialId),
    /** The answer to navigator.credentials.create() for these options. */
    create: (options: { challenge: string }) => {
      const coseKey = cbor(
        new Map<Cbor, Cbor>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x ?? "", "base64url")],
          [-3, Buffer.from(jwk.y ?? "", "base64url")],
        ]),
      );
      const idLength = Buffer.from([credentialId.length >> 8, credentialId.length & 0xff]);
      const authData = Buffer.concat([
        sha256(rpId),
        Buffer.from([0x45]), // user present + verified + attested credential data
        counterBytes(counter),
        Buffer.alloc(16), // aaguid
        idLength,
        credentialId,
        coseKey,
      ]);
      const attestationObject = cbor(
        new Map<Cbor, Cbor>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key",
        response: {
          clientDataJSON: b64url(clientData("webauthn.create", options.challenge)),
          attestationObject: b64url(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
    /** The answer to navigator.credentials.get() for these options. */
    get: (options: { challenge: string }) => {
      counter += 1;
      const authenticatorData = Buffer.concat([
        sha256(rpId),
        Buffer.from([0x05]), // user present + verified
        counterBytes(counter),
      ]);
      const clientDataJSON = clientData("webauthn.get", options.challenge);
      const signature = sign(
        "sha256",
        Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
        privateKey,
      );
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authenticatorData),
          signature: b64url(signature),
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
  };
};
