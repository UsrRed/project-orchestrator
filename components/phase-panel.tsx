/**
 * Panneau contextuel adaptatif par type de phase (Milestone 6).
 *
 * Mapping `phase.type → panneau` : chaque type de phase affiche des repères
 * méthodologiques adaptés. Le mapping est fixe et whitelisté (pas de contenu
 * exécutable), il oriente simplement l'UI selon la nature de la phase.
 */
interface PanelSpec {
  label: string;
  accent: string;
  focus: string[];
}

const PANELS: Record<string, PanelSpec> = {
  recherche: {
    label: "Recherche & cadrage",
    accent: "text-violet-300 border-violet-900/50 bg-violet-950/10",
    focus: ["Hypothèses à valider", "Sources & entretiens", "Critères de succès"],
  },
  design: {
    label: "Design",
    accent: "text-pink-300 border-pink-900/50 bg-pink-950/10",
    focus: ["Cohérence visuelle", "Accessibilité", "Parcours utilisateur"],
  },
  developpement: {
    label: "Développement",
    accent: "text-sky-300 border-sky-900/50 bg-sky-950/10",
    focus: ["Découpage en tâches", "Tests", "Revue de code"],
  },
  marketing: {
    label: "Marketing",
    accent: "text-amber-300 border-amber-900/50 bg-amber-950/10",
    focus: ["Cible & positionnement", "Canaux", "KPIs de campagne"],
  },
  lancement: {
    label: "Lancement",
    accent: "text-emerald-300 border-emerald-900/50 bg-emerald-950/10",
    focus: ["Checklist de mise en ligne", "Communication", "Suivi post-lancement"],
  },
};

const DEFAULT_PANEL: PanelSpec = {
  label: "Phase",
  accent: "text-neutral-300 border-neutral-800 bg-neutral-900/40",
  focus: ["Objectifs de la phase", "Livrables attendus", "Points de vigilance"],
};

/** Normalise un type de phase libre vers une clé de panneau connue. */
export function panelKeyFor(phaseType: string | null): string {
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

export function PhasePanel({
  phaseName,
  phaseType,
}: {
  phaseName: string;
  phaseType: string | null;
}) {
  const spec = PANELS[panelKeyFor(phaseType)] ?? DEFAULT_PANEL;
  return (
    <div className={`rounded-xl border px-4 py-3 ${spec.accent}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide">
          {spec.label}
        </span>
        <span className="text-xs opacity-60">· {phaseName}</span>
      </div>
      <ul className="mt-2 flex flex-wrap gap-2">
        {spec.focus.map((f) => (
          <li
            key={f}
            className="rounded-full border border-current/20 px-2 py-0.5 text-xs opacity-80"
          >
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}
