/**
 * Sources d'exécution d'un run autonome — l'axe du routage dynamique.
 *
 * Le routeur LLM ([llm-router.ts](llm-router.ts)) choisit un **modèle** ; il ne
 * sait rien de ce qui le paie. Or c'est précisément la question du mode
 * Autonome : une même tâche peut partir sur le modèle local (gratuit, déjà
 * chargé), sur l'abonnement d'un agent CLI (coût marginal nul, mais un siège
 * payé au mois), sur un modèle gratuit d'API, ou sur du payant à la consommation.
 * Ces quatre voies ne se comparent pas par leur prix au token — trois d'entre
 * elles valent 0 — d'où ce type dédié.
 *
 * **Politique** (cf. décision produit) : parmi les seules sources capables de
 * la tâche (niveau estimé ≤ niveau de la source), on suit l'ordre de préférence
 * de l'utilisateur, et au sein d'une source on prend le **moins intelligent qui
 * suffit** — on ne paie pas un modèle expert pour une tâche de niveau 1.
 *
 * Module **pur et client-safe** (aucun import Node ni server-only) : le panneau
 * du mode Autonome l'importe pour ses libellés.
 */

/**
 * `paid` est absent de l'ordre configurable à dessein : ce n'est pas une
 * préférence mais un dernier recours, et il est de toute façon interdit quand
 * le plafond du run vaut 0. Il est toujours essayé en dernier.
 */
export type SourceKind = "local" | "subscription" | "free" | "paid";

/** Sources que l'utilisateur peut ordonner (cf. `paid`, toujours en dernier). */
export type OrderedSourceKind = Exclude<SourceKind, "paid">;

export const ORDERED_SOURCE_KINDS: readonly OrderedSourceKind[] = [
  "local",
  "subscription",
  "free",
] as const;

/**
 * Ordre par défaut : le local d'abord (gratuit *et* privé, rien ne sort de la
 * machine), puis l'abonnement (déjà payé, coût marginal nul), puis les modèles
 * gratuits d'API (gratuits mais distants et souvent bridés).
 */
export const DEFAULT_SOURCE_ORDER: readonly OrderedSourceKind[] = [
  "local",
  "subscription",
  "free",
] as const;

export const SOURCE_LABEL: Record<SourceKind, string> = {
  local: "Local",
  subscription: "Abonnement",
  free: "Gratuit",
  paid: "Payant",
};

export const SOURCE_HINT: Record<SourceKind, string> = {
  local: "Modèle chargé sur ta machine (LM Studio / Ollama). Gratuit, privé.",
  subscription: "Agent CLI avec son propre login (Claude Code…). Déjà payé au mois.",
  free: "Modèle gratuit d'un provider d'API (OpenCode Zen, OpenRouter :free).",
  paid: "Modèle facturé au token. N'est tenté qu'en dernier, et jamais si le plafond du run vaut 0.",
};

function isOrderedSourceKind(v: string): v is OrderedSourceKind {
  return (ORDERED_SOURCE_KINDS as readonly string[]).includes(v);
}

/**
 * Lit un ordre stocké (CSV) en le réparant : entrées inconnues jetées, doublons
 * écartés, sources manquantes complétées dans l'ordre par défaut.
 *
 * Toujours complété plutôt que rejeté : un ordre partiel exprime une préférence
 * (« l'abonnement d'abord ») sans vouloir dire « n'essaie jamais le reste » —
 * amputer la liste supprimerait des sources capables et ferait échouer des runs
 * qu'on savait exécuter.
 */
export function parseSourceOrder(
  raw: string | null | undefined,
): OrderedSourceKind[] {
  const seen = new Set<OrderedSourceKind>();
  const out: OrderedSourceKind[] = [];
  for (const part of (raw ?? "").split(",")) {
    const v = part.trim();
    if (isOrderedSourceKind(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  for (const v of DEFAULT_SOURCE_ORDER) {
    if (!seen.has(v)) out.push(v);
  }
  return out;
}

export function serializeSourceOrder(
  order: readonly OrderedSourceKind[],
): string {
  return parseSourceOrder(order.join(",")).join(",");
}

/**
 * Ordre complet réellement essayé : la préférence de l'utilisateur, puis le
 * payant — et seulement si le run l'autorise (plafond > 0).
 */
export function fullSourceOrder(
  order: readonly OrderedSourceKind[],
  opts: { allowPaid: boolean },
): SourceKind[] {
  const base: SourceKind[] = [...parseSourceOrder(order.join(","))];
  return opts.allowPaid ? [...base, "paid"] : base;
}

