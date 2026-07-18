/**
 * Choix de modèle par rôle d'assistance.
 *
 * Depuis le pivot « Claude uniquement », le CLI choisit « auto » = le modèle le
 * plus puissant de l'abonnement (Fable 5) pour TOUT appel. C'est surdimensionné
 * pour les petites générations (suggestions de prompts, widgets, chat, découpage
 * de projet). On force donc, par rôle, un modèle proportionné via l'option
 * `model` de [claude-cli.ts](claude-cli.ts) (passée en `--model` au binaire).
 *
 * Le **run autonome** — le seul rôle qui écrit réellement dans le dépôt du
 * projet ([cli-agent.ts](cli-agent.ts)) — n'est PAS listé ici : il reste en
 * « auto » (max), car c'est là que la puissance du modèle compte vraiment.
 *
 * Valeurs = alias acceptés par `claude --model` (`fable` | `opus` | `sonnet` |
 * `haiku`), ou un id complet (`claude-fable-5`). On garde des alias : ils
 * suivent automatiquement la dernière version de chaque palier.
 */

/** Rôles d'assistance (hors run autonome, qui reste en « auto »). */
export type AssistRole =
  | "architect"
  | "chat"
  | "cowork-options"
  | "cowork-artifact"
  | "suggestions"
  | "widget";

/**
 * Mapping rôle → modèle (profil « équilibré »).
 *
 * - `sonnet` pour le raisonnement utile : découpage du projet (architect),
 *   conversation, options et livrable Cowork.
 * - `haiku` pour le jetable/structuré : suggestions de prompts et widgets.
 */
export const MODEL_BY_ROLE: Record<AssistRole, string> = {
  architect: "sonnet",
  chat: "sonnet",
  "cowork-options": "sonnet",
  "cowork-artifact": "sonnet",
  suggestions: "haiku",
  widget: "haiku",
};

/** Modèle à imposer pour un rôle d'assistance donné. */
export function modelFor(role: AssistRole): string {
  return MODEL_BY_ROLE[role];
}
