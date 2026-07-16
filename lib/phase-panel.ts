/**
 * Mapping (pur) type de phase → clé de panneau adaptatif (M6).
 * Séparé de la vue (`components/phase-panel.tsx`) pour être testable sans JSX.
 */
export type PanelKey =
  | "recherche"
  | "design"
  | "developpement"
  | "marketing"
  | "lancement"
  | "default";

/** Normalise un type de phase libre vers une clé de panneau connue. */
export function panelKeyFor(phaseType: string | null): PanelKey {
  if (!phaseType) return "default";
  // Minuscule + suppression des accents pour un matching robuste.
  const t = phaseType
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (t.includes("recherch") || t.includes("cadrage")) return "recherche";
  if (t.includes("design") || t.includes("ux") || t.includes("ui")) return "design";
  if (t.includes("dev") || t.includes("code") || t.includes("techn")) return "developpement";
  if (t.includes("market") || t.includes("comm")) return "marketing";
  if (t.includes("lancement") || t.includes("launch") || t.includes("release")) return "lancement";
  return "default";
}
