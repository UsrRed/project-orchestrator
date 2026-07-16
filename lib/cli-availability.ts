/**
 * Détection des agents CLI installés sur la machine.
 *
 * Séparé du registre ([cli-agents.ts](cli-agents.ts)) parce que celui-ci doit
 * rester client-safe : ce module importe `node:fs` et ne doit jamais finir dans
 * le bundle navigateur.
 *
 * ⚠️ Hypothèse : le serveur Next et le worker tournent sur la **même machine**
 * (vrai en usage perso). Sinon cette détection décrit le serveur alors que
 * l'exécution a lieu sur le worker, et l'UI peut proposer un CLI absent
 * là-bas — le run échouerait alors avec « CLI introuvable ».
 */
import "server-only";

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import { CLI_AGENTS, type CliAgentId } from "@/lib/cli-agents";

/** Le binaire est-il exécutable quelque part dans le PATH ? */
export function isBinOnPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export interface CliAgentStatus {
  id: CliAgentId;
  label: string;
  available: boolean;
  reportsCost: boolean;
  /** Raison d'indisponibilité, ou limite connue à afficher à l'utilisateur. */
  warning?: string;
}

/**
 * État de chaque agent CLI pour l'UI. Un CLI installé mais avec un problème
 * connu (`knownIssue`) est marqué **indisponible** : mieux vaut le griser avec
 * la raison que laisser l'utilisateur lancer un run voué à échouer.
 */
export function cliAgentStatuses(): CliAgentStatus[] {
  return CLI_AGENTS.map((c) => {
    const onPath = isBinOnPath(c.bin);
    return {
      id: c.id,
      label: c.label,
      available: onPath && !c.knownIssue,
      reportsCost: c.reportsCost,
      warning: !onPath
        ? `Binaire \`${c.bin}\` introuvable dans le PATH.`
        : (c.knownIssue ?? (c.reportsCost ? undefined : c.note)),
    };
  });
}
