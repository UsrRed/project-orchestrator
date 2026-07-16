/**
 * Niveau d'intelligence d'un modèle — l'axe du routage.
 *
 * **models.dev ne fournit aucun score de capacité** (ni benchmark, ni
 * classement) : ce niveau est donc produit ici, par deux voies complémentaires.
 *
 *  1. **Table curée par famille** (`FAMILY_LEVELS`) — models.dev regroupe les
 *     modèles en familles stables (`claude-opus`, `gpt-nano`, `gemini-flash`…).
 *     La table encode ce qu'on sait de ces familles. C'est une **correction**
 *     appliquée là où le prix ment.
 *  2. **Dérivation par signaux** (`deriveLevel`) — pour tout le reste (familles
 *     hétérogènes comme `gpt` ou `qwen`, modèles inconnus, nouveautés). Le prix
 *     y sert de proxy de capacité, corrigé par le raisonnement et le contexte.
 *
 * Pourquoi ce partage plutôt que l'un des deux seuls : une table exhaustive
 * (110 familles) vieillirait mal et rendrait tout modèle nouveau non routable ;
 * une dérivation seule n'est qu'un « cher = intelligent » sophistiqué, qui se
 * trompe précisément sur les modèles intéressants (un Haiku bon marché, un
 * DeepSeek de raisonnement à 0,43 $).
 *
 * ⚠️ La table est une **connaissance datée**, pas une mesure. Elle reflète ce
 * qui était su à sa rédaction (2026-07) et doit être révisée ; un modèle absent
 * n'est pas un bug, il tombe simplement dans la dérivation.
 */

/**
 * Signaux nécessaires pour situer un modèle. Décrits ici plutôt qu'importés de
 * [model-catalog.ts](model-catalog.ts) : c'est ce module-là qui appelle
 * celui-ci, et un `CatalogModel` satisfait cette forme par structure. Pas
 * d'import ⇒ pas de cycle.
 */
export interface ModelSignals {
  id: string;
  family: string | null;
  /** USD / 1M tokens. */
  input: number;
  output: number;
  context: number;
  reasoning: boolean;
  /** ISO `YYYY-MM-DD`. Sert à ne pas surcoter les anciens modèles chers. */
  release_date?: string | null;
}

/**
 * Cinq niveaux ordinaux. Volontairement grossiers : la source ne justifie pas
 * la précision qu'afficherait un score sur 100.
 */
export type IntelligenceLevel = 0 | 1 | 2 | 3 | 4;

export const INTELLIGENCE_LEVELS: readonly IntelligenceLevel[] = [
  0, 1, 2, 3, 4,
] as const;

export const LEVEL_LABEL: Record<IntelligenceLevel, string> = {
  0: "basique",
  1: "standard",
  2: "avancé",
  3: "expert",
  4: "frontière",
};

export const LEVEL_HINT: Record<IntelligenceLevel, string> = {
  0: "Reformulation, extraction, classification triviale.",
  1: "Résumés, traductions, réponses courtes.",
  2: "Rédaction structurée, code simple, la plupart des tâches courantes.",
  3: "Raisonnement multi-étapes, architecture, code non trivial.",
  4: "Les tâches les plus dures : long-horizon, raisonnement profond.",
};

/**
 * Niveaux curés par famille models.dev.
 *
 * N'y figurent que les familles **effectivement connues** : mieux vaut laisser
 * la dérivation faire son travail que d'inventer un niveau pour une famille
 * qu'on ne sait pas situer. C'est aussi pourquoi les familles hétérogènes
 * (`gpt`, 45 modèles de 0,50 $ à 30 $ ; `qwen`, 48 modèles) sont absentes : un
 * niveau unique y serait faux pour la moitié de leurs modèles.
 */
export const FAMILY_LEVELS: Readonly<Record<string, IntelligenceLevel>> = {
  // Anthropic — hiérarchie explicite du provider.
  "claude-opus": 4,
  "claude-fable": 4,
  "claude-sonnet": 3,
  "claude-haiku": 2, // Bon marché ($1) mais loin d'être « standard ».

  // OpenAI — les suffixes disent le positionnement.
  "gpt-pro": 4,
  "o-pro": 4,
  o: 3,
  "gpt-codex": 3, // Spécialiste code : au-dessus de ce que son prix suggère.
  "gpt-mini": 2,
  "o-mini": 2,
  "gpt-oss": 2,
  "gpt-nano": 1,

  // Google.
  "gemini-pro": 3,
  "gemini-flash": 2,
  "gemini-flash-lite": 1,
  gemma: 1,

  // Poids ouverts / autres — le prix les sous-estime systématiquement.
  "deepseek-thinking": 3, // Raisonnement fort à ~0,43 $.
  deepseek: 2,
  grok: 3,
  "mistral-large": 3,
  "mistral-medium": 2,
  "mistral-small": 1,
  glm: 2,
  "kimi-k2": 2,
  nemotron: 2,
  "command-a": 2,
  "command-r": 1,
  llama: 1,
};

/** Prix pondéré en USD/1M tokens (la sortie pèse moins : on en produit moins). */
function weightedPrice(m: ModelSignals): number {
  return m.input + m.output / 3;
}

/**
 * Marqueurs de « petite variante » dans un identifiant de modèle.
 *
 * `-mini`, `-nano`, `-lite`… désignent le petit frère d'une famille. Nécessaire
 * parce que la famille models.dev regroupe les deux : `gpt-codex` contient
 * aussi bien `gpt-5-codex` que `gpt-5.1-codex-mini` à 0,25 $, qu'un niveau
 * unique déclarerait à tort également capables.
 */
const VARIANT_RE = /[-_.](mini|nano|lite|tiny|small|flash)\b/i;

/**
 * Âge à partir duquel un modèle est déclassé d'un cran (mois).
 *
 * Le prix des modèles anciens ne baisse pas quand l'état de l'art avance : sans
 * ça, un GPT-4o de mai 2024 à 5 $ est dérivé « frontière » et bat les modèles
 * récents en mode boost. ~18 mois est un compromis : assez long pour ne pas
 * punir un flagship de l'année, assez court pour refléter le rythme réel.
 */
const STALE_AFTER_MONTHS = 18;

/** Âge du modèle en mois, ou null si models.dev n'a pas la date. */
function ageInMonths(
  release: string | null | undefined,
  now: Date,
): number | null {
  if (!release) return null;
  const d = new Date(release);
  if (Number.isNaN(d.getTime())) return null;
  return (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

/** Le modèle porte-t-il un suffixe de petite variante que sa famille n'a pas ? */
function isSmallVariant(m: ModelSignals): boolean {
  // Si la famille encode déjà la variante (`gpt-mini`, `gemini-flash-lite`),
  // son niveau curé en tient compte : pénaliser deux fois serait faux.
  if (m.family && VARIANT_RE.test(`-${m.family}`)) return false;
  return VARIANT_RE.test(m.id);
}

/**
 * Niveau déduit des seuls signaux du catalogue, quand la famille est inconnue.
 *
 * Le prix est le meilleur proxy disponible — un provider tarife ses modèles
 * selon ce qu'ils valent — mais il est muet sur les modèles gratuits, qui sont
 * donc jugés sur le raisonnement et le contexte. Grossier par construction :
 * c'est le rôle de `FAMILY_LEVELS` de corriger les cas connus.
 */
export function deriveLevel(
  m: ModelSignals,
  now: Date = new Date(),
): IntelligenceLevel {
  const price = weightedPrice(m);

  let level: number;
  if (price === 0) {
    // Gratuit : le prix n'informe plus. Un gratuit qui raisonne avec un grand
    // contexte est un bon modèle, mais on ne le hisse pas au niveau frontière
    // sans preuve — les gratuits sont des versions bridées ou plus petites.
    level = 1;
    if (m.reasoning) level += 1;
    if (m.context >= 128_000) level += 1;
    level = Math.min(level, 3);
  } else {
    if (price >= 8) level = 4;
    else if (price >= 2.5) level = 3;
    else if (price >= 0.6) level = 2;
    else level = 1;

    // Le raisonnement explicite relève d'un cran les modèles bon marché ; il
    // n'ajoute rien à un modèle déjà cher (il y est la norme).
    if (m.reasoning && level < 3) level += 1;
    // Un contexte minuscule trahit un modèle limité, quel que soit son prix.
    if (m.context < 16_000) level -= 1;
  }

  return adjust(level, m, now);
}

/**
 * Ajustements valables quelle que soit l'origine du niveau (table ou
 * dérivation) : ce sont des propriétés du **modèle**, pas de la méthode.
 *
 * Sans l'ajustement d'âge sur les familles curées, `gpt-4o-mini` (juillet 2024)
 * resterait « avancé » pour toujours et gagnerait le tier `fast` par son prix.
 */
function adjust(base: number, m: ModelSignals, now: Date): IntelligenceLevel {
  let level = base;
  const age = ageInMonths(m.release_date, now);
  if (age !== null && age > STALE_AFTER_MONTHS) level -= 1;
  if (isSmallVariant(m)) level -= 1;
  return clamp(level);
}

function clamp(n: number): IntelligenceLevel {
  return Math.max(0, Math.min(4, Math.round(n))) as IntelligenceLevel;
}

export interface LevelAssessment {
  level: IntelligenceLevel;
  /** D'où vient le niveau — affiché pour ne pas faire passer une estimation
   *  pour une mesure. */
  source: "family" | "derived";
  family: string | null;
}

/**
 * Niveau d'un modèle : la table d'abord, la dérivation en repli — puis les
 * ajustements d'âge et de variante dans les deux cas. Le niveau de la table
 * vaut pour la **famille** ; il ne dit rien du `-mini` ni du millésime.
 */
export function assessLevel(
  m: ModelSignals,
  now: Date = new Date(),
): LevelAssessment {
  const family = m.family ?? null;
  const curated = family ? FAMILY_LEVELS[family] : undefined;
  if (curated !== undefined) {
    return { level: adjust(curated, m, now), source: "family", family };
  }
  return { level: deriveLevel(m, now), source: "derived", family };
}

/** Raccourci quand seule la valeur importe. */
export function levelOf(m: ModelSignals, now: Date = new Date()): IntelligenceLevel {
  return assessLevel(m, now).level;
}
