/**
 * Chiffrement applicatif des clés API utilisateur — AES-256-GCM.
 *
 * Principes (cf. plan de développement, section sécurité) :
 *  - clé maître HORS base de données (ENCRYPTION_MASTER_KEY, secret manager) ;
 *  - IV aléatoire (96 bits) par chiffrement ;
 *  - tag d'authentification GCM vérifié au déchiffrement (intégrité) ;
 *  - format de sortie : base64(iv) : base64(authTag) : base64(ciphertext).
 *
 * La clé maître doit être 32 octets, fournie en base64
 * (générer : `openssl rand -base64 32`).
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits, recommandé pour GCM
const KEY_LENGTH = 32; // 256 bits
const AUTH_TAG_LENGTH = 16;
const SEPARATOR = ":";

let cachedKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.ENCRYPTION_MASTER_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_MASTER_KEY manquante. Générer avec `openssl rand -base64 32`.",
    );
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_MASTER_KEY invalide : ${key.length} octets décodés, ${KEY_LENGTH} attendus.`,
    );
  }

  cachedKey = key;
  return key;
}

/**
 * Chiffre une valeur en clair (ex: une clé API) et renvoie une chaîne opaque
 * stockable en base : "iv:authTag:ciphertext" (chaque partie en base64).
 */
export function encrypt(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(SEPARATOR);
}

/**
 * Déchiffre une chaîne produite par `encrypt`. Lève une erreur si le format
 * est invalide ou si le tag d'authentification ne correspond pas (donnée
 * altérée / mauvaise clé).
 */
export function decrypt(payload: string): string {
  const key = getMasterKey();
  const parts = payload.split(SEPARATOR);
  if (parts.length !== 3) {
    throw new Error("Payload chiffré invalide (format attendu iv:tag:data).");
  }

  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(dataB64, "base64");

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Payload chiffré invalide (IV ou tag de taille incorrecte).");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Masque une clé pour l'affichage UI (ne jamais renvoyer la clé en clair au
 * client). Ex: "sk-ant-...V8xQ".
 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return "••••";
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`;
}

/** Comparaison à temps constant (utile pour vérifier des secrets/HMAC). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
