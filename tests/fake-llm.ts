/**
 * Faux modèle, branché là où un vrai le serait : **au bout du réseau**.
 *
 * Le test fonctionnel doit tourner en CI, où il n'y a ni clé API, ni modèle
 * local, ni agent CLI. Plutôt que de simuler nos propres modules — ce qui
 * reviendrait à tester des bouchons — on sert ici l'API `/chat/completions`
 * d'OpenAI, et on branche le provider `ollama` dessus via `LOCAL_AI_BASE_URL`.
 * Tout le reste de la plateforme s'exécute pour de vrai : routage, niveaux,
 * planification, worker, garde-fous, base. Seule la réponse du modèle est
 * fabriquée.
 *
 * Le contenu est dérivé du **JSON Schema que l'appelant envoie** (structured
 * outputs), pas de fixtures écrites à la main : un schéma qui évolue reste servi
 * correctement, et le test ne casse pas pour un champ ajouté ailleurs. Le test
 * n'impose que les valeurs dont il a besoin (`values`).
 */
import { createServer, type Server } from "node:http";

/** Ce qu'un appel a demandé — matière à assertions. */
export interface FakeCall {
  /** Ordre global d'arrivée (0-based). */
  index: number;
  /** Rang de cet appel parmi ceux qui demandent le MÊME schéma (0-based). */
  sameSchemaIndex: number;
  /** Propriétés de premier niveau du schéma demandé (vide si texte libre). */
  properties: string[];
  system: string;
  /** Contenu utilisateur concaténé. */
  prompt: string;
  model: string;
  structured: boolean;
}

export type ValueFactory = (call: FakeCall) => unknown;

export interface FakeLlmConfig {
  /**
   * Valeurs imposées, par **nom de propriété**, à n'importe quelle profondeur.
   * Une fonction reçoit l'appel courant (utile pour faire varier une réponse
   * d'une itération à l'autre : `done: (c) => c.sameSchemaIndex >= 1`).
   */
  values?: Record<string, unknown | ValueFactory>;
  /** Réponse des appels en texte libre (`generateText`). */
  text?: string | ValueFactory;
  /** Code HTTP à renvoyer au lieu d'une réponse (test des reprises). */
  failWith?: number;
}

export interface FakeLlm {
  /** À placer dans `LOCAL_AI_BASE_URL`. */
  url: string;
  calls: FakeCall[];
  /** Change le comportement en cours de test (une phase = un comportement). */
  configure(config: FakeLlmConfig): void;
  /** Oublie les appels enregistrés (mais garde la configuration). */
  reset(): void;
  close(): Promise<void>;
}

// --- Génération d'une valeur conforme à un JSON Schema -------------------

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  /** Valeur imposée (un `z.literal`, ex. le discriminant d'une union). */
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  description?: string;
}

/** `type` peut être `["string","null"]` (nullable) : on ignore le `null`. */
function primaryType(schema: JsonSchema): string | undefined {
  const t = schema.type;
  if (Array.isArray(t)) return t.find((x) => x !== "null");
  return t;
}

/**
 * Combien d'éléments produire pour un tableau.
 *
 * Deux quand c'est permis : un tableau à un seul élément laisserait passer des
 * bugs d'itération (une boucle qui ne traite que le premier), et les schémas du
 * produit demandent presque tous « 2 à N ».
 */
function itemCount(schema: JsonSchema): number {
  const min = schema.minItems ?? 1;
  const max = schema.maxItems ?? Math.max(min, 2);
  return Math.min(Math.max(min, 2), max);
}

function fakeNumber(schema: JsonSchema): number {
  const min = schema.minimum ?? 1;
  const max = schema.maximum ?? min + 1;
  // Le bas de la fourchette : une valeur plausible et surtout stable.
  return Math.min(min, max);
}

class SchemaFaker {
  constructor(
    private readonly config: FakeLlmConfig,
    private readonly call: FakeCall,
  ) {}

  build(schema: JsonSchema, key: string): unknown {
    const override = this.config.values?.[key];
    if (override !== undefined) {
      return typeof override === "function"
        ? (override as ValueFactory)(this.call)
        : override;
    }
    // `const` avant tout le reste : c'est le discriminant d'une union
    // (`z.literal`), et le remplacer par du texte quelconque produit un objet
    // qui ne valide contre AUCUNE variante.
    if (schema.const !== undefined) return schema.const;
    if (schema.enum && schema.enum.length > 0) return schema.enum[0];

    const variants = schema.anyOf ?? schema.oneOf;
    if (variants && variants.length > 0) {
      const first =
        variants.find((v) => primaryType(v) && primaryType(v) !== "null") ??
        variants[0]!;
      return this.build(first, key);
    }

    switch (primaryType(schema)) {
      case "object": {
        const out: Record<string, unknown> = {};
        for (const [name, sub] of Object.entries(schema.properties ?? {})) {
          out[name] = this.build(sub, name);
        }
        return out;
      }
      case "array": {
        const items = schema.items ?? {};
        return Array.from({ length: itemCount(schema) }, (_, i) =>
          this.build(items, `${key}[${i}]`),
        );
      }
      case "boolean":
        // `false` par défaut : le neutre. Un `true` implicite mettrait fin à une
        // boucle autonome (`done`) sans que le test l'ait demandé.
        return false;
      case "integer":
      case "number":
        return fakeNumber(schema);
      case "null":
        return null;
      default:
        return `${key} (faux modèle)`;
    }
  }
}

// --- Serveur -------------------------------------------------------------

interface ChatBody {
  model?: string;
  messages?: { role: string; content: unknown }[];
  response_format?: {
    type?: string;
    json_schema?: { name?: string; schema?: JsonSchema };
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && "text" in p ? String(p.text) : "",
      )
      .join("");
  }
  return "";
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

/** ~4 caractères par token — la même approximation que le routeur. */
const tokens = (s: string) => Math.ceil(s.length / 4);

export async function startFakeLlm(
  initial: FakeLlmConfig = {},
): Promise<FakeLlm> {
  let config = initial;
  const calls: FakeCall[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const send = (code: number, payload: unknown): void => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      // Le catalogue local (page /models) ; sans objet ici mais répondre évite
      // un bruit d'erreur si quelque chose l'interroge.
      if (req.method === "GET" && req.url?.includes("/models")) {
        return send(200, { data: [{ id: "qwen-active", object: "model" }] });
      }
      if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
        return send(404, { error: { message: `Route inconnue : ${req.url}` } });
      }
      if (config.failWith) {
        return send(config.failWith, { error: { message: "panne simulée" } });
      }

      const body = JSON.parse(await readBody(req)) as ChatBody;
      const schema = body.response_format?.json_schema?.schema;
      const messages = body.messages ?? [];
      const properties = schema?.properties
        ? Object.keys(schema.properties)
        : [];
      const signature = properties.join(",");

      const call: FakeCall = {
        index: calls.length,
        sameSchemaIndex: calls.filter((c) => c.properties.join(",") === signature)
          .length,
        properties,
        system: messages
          .filter((m) => m.role === "system")
          .map((m) => textOf(m.content))
          .join("\n"),
        prompt: messages
          .filter((m) => m.role !== "system")
          .map((m) => textOf(m.content))
          .join("\n"),
        model: body.model ?? "",
        structured: Boolean(schema),
      };
      calls.push(call);

      const content: string = schema
        ? JSON.stringify(new SchemaFaker(config, call).build(schema, "root"))
        : typeof config.text === "function"
          ? String(config.text(call))
          : (config.text ?? "Réponse du faux modèle.");

      send(200, {
        id: `chatcmpl-${call.index}`,
        object: "chat.completion",
        created: 0,
        model: call.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        // Des tokens non nuls : c'est ce qui alimente le journal de coût, et un
        // 0 masquerait une régression de comptabilisation.
        usage: {
          prompt_tokens: tokens(call.system + call.prompt),
          completion_tokens: tokens(content),
          total_tokens: tokens(call.system + call.prompt + content),
        },
      });
    })().catch(() => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "faux modèle en erreur" } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Le faux modèle n'a pas pu ouvrir de port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    calls,
    configure: (next) => {
      config = next;
    },
    reset: () => {
      calls.length = 0;
    },
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
