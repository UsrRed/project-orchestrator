/**
 * Serveur MCP de l'orchestrateur (stdio).
 *
 * Expose l'orchestrateur comme **serveur MCP** : un agent externe (Claude Code,
 * Claude Desktop, un cron autonome…) pilote tout le cycle d'un projet — créer
 * l'arborescence, l'éditer, discuter les tâches (Manuel / Cowork), lancer des
 * runs **autonomes**, suivre leur état et lire les livrables — sans passer par
 * l'UI web.
 *
 * Deux traits le rendent autosuffisant :
 *  - il parle à la **même base** que le web (mêmes fonctions `lib/`), donc ce
 *    qu'un agent crée par MCP apparaît dans l'UI et inversement ;
 *  - il **héberge lui-même la boucle worker** (`startWorkerLoop`), si bien qu'un
 *    run mis en file par `launch_autonomous_run` s'exécute même sans serveur web.
 *    Le claim de la queue est atomique (`FOR UPDATE SKIP LOCKED`) : ce worker et
 *    un worker web/dédié peuvent coexister sans double traitement. Poser
 *    `MCP_INLINE_WORKER=0` pour déléguer l'exécution au web/`npm run worker`.
 *
 * Lancement :  npm run mcp   (tsx --conditions=react-server, comme le worker)
 */
import { readFileSync } from "node:fs";

// --- Chargement du .env (comme scripts/worker.ts : Next ne le fait pas ici) ---
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && !process.env[m[1]]) {
      let v = (m[2] ?? "").trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
} catch {
  // pas de .env : variables supposées déjà présentes dans l'environnement.
}

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
// Imports de types seulement : élidés au runtime, donc sans effet sur l'ordre
// « .env chargé avant db.ts » (contrairement aux imports de valeurs plus bas).
import type { HistoryMessage } from "@/lib/agent";
import type { Architecture, ProjectType } from "@/lib/architect";
import type { CliModelUsage } from "@/lib/cli-agents";

async function main(): Promise<void> {
  // Imports dynamiques APRÈS le chargement du .env : `db.ts` lit `process.env`
  // à l'import, et tout ce qui suit tire la base.
  const [
    architect,
    projects,
    conversation,
    runs,
    normes,
    budgets,
    agent,
    widgets,
    executions,
    profileMod,
    users,
    workerRuntime,
  ] = await Promise.all([
    import("@/lib/architect"),
    import("@/lib/projects"),
    import("@/lib/conversation"),
    import("@/lib/runs"),
    import("@/lib/normes"),
    import("@/lib/budgets"),
    import("@/lib/agent"),
    import("@/lib/widgets"),
    import("@/lib/executions"),
    import("@/lib/profile"),
    import("@/lib/users"),
    import("@/lib/worker-runtime"),
  ]);

  const uid = () => users.getCurrentUserId();

  // --- Helpers de sortie MCP ---------------------------------------------
  const json = (data: unknown): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  });
  const fail = (message: string): CallToolResult => ({
    isError: true,
    content: [{ type: "text", text: message }],
  });

  /** Historique aplati pour l'agent (comme buildHistory des actions). */
  async function history(
    userId: string,
    taskId: string,
  ): Promise<HistoryMessage[]> {
    const msgs = await conversation.listMessages(userId, taskId);
    return msgs
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
  }

  async function record(
    userId: string,
    label: string,
    link: { projectId: string; taskId?: string },
    meta: { usage: CliModelUsage[]; costUsd: number },
    startedAt: Date,
  ): Promise<void> {
    await executions.recordClaudeExecution(
      {
        userId,
        taskLabel: label,
        projectId: link.projectId,
        taskId: link.taskId,
        status: "succeeded",
        startedAt,
        finishedAt: new Date(),
      },
      meta.usage,
      meta.costUsd,
    );
  }

  const server = new McpServer({
    name: "orchestrato",
    version: "1.0.0",
  });

  // =====================================================================
  //  PROJETS — cycle de vie
  // =====================================================================

  server.registerTool(
    "list_projects",
    {
      title: "Lister les projets",
      description:
        "Liste tous les projets de l'utilisateur (id, nom, type, avancement).",
      inputSchema: {},
    },
    async () => json(await projects.listProjects(await uid())),
  );

  server.registerTool(
    "create_project",
    {
      title: "Créer un projet (architecte)",
      description:
        "L'agent architecte transforme une idée en langage naturel en " +
        "arborescence Projet → Phases → Tâches, la persiste, journalise le coût, " +
        "et renvoie l'arborescence. Appel LLM réel (Claude Code).",
      inputSchema: {
        idea: z.string().min(1).describe("L'idée de projet, en langage naturel."),
        type: z
          .enum(["tech", "marketing"])
          .default("tech")
          .describe("Catégorie du projet (pilote le prépanneau adaptatif)."),
        repoFullName: z
          .string()
          .optional()
          .describe(
            "Optionnel : « proprietaire/depot » pour lier un dépôt GitHub " +
              "(supposé privé). Absent = projet local, aucun dépôt.",
          ),
      },
    },
    async ({ idea, type, repoFullName }) => {
      const userId = await uid();
      const repo = repoFullName
        ? {
            mode: "github" as const,
            fullName: repoFullName,
            url: `https://github.com/${repoFullName}`,
            private: true,
          }
        : projects.LOCAL_REPO;
      const profile = await profileMod.getProfile(userId);
      const startedAt = new Date();
      const result = await architect.generateArchitecture(
        idea,
        type,
        profileMod.profilePreamble(profile),
      );
      const projectId = await projects.createProjectFromArchitecture(
        userId,
        idea,
        type,
        result.architecture,
        repo,
      );
      await normes.autoAssociateProjectNorms(userId, projectId);
      if (profile.defaultBudgetTokens && profile.defaultBudgetTokens > 0) {
        await budgets.setBudget(userId, projectId, profile.defaultBudgetTokens);
      }
      await record(
        userId,
        `[architecture] ${result.architecture.projectName}`,
        { projectId },
        result,
        startedAt,
      );
      return json({ projectId, tree: await projects.getProjectTree(userId, projectId) });
    },
  );

  server.registerTool(
    "get_project",
    {
      title: "Arborescence d'un projet",
      description:
        "Renvoie l'arborescence complète (phases, tâches avec leur id/mode/" +
        "statut/priorité, dépôt, idée). C'est la vue à lire avant d'agir.",
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      const tree = await projects.getProjectTree(await uid(), projectId);
      return tree ? json(tree) : fail("Projet introuvable.");
    },
  );

  server.registerTool(
    "refine_project",
    {
      title: "Affiner l'arborescence (architecte)",
      description:
        "Régénère phases et tâches en tenant compte d'une contrainte " +
        "(ex: « ajoute une phase sécurité »). Remplace l'arborescence. Appel LLM.",
      inputSchema: {
        projectId: z.string(),
        constraint: z.string().min(1).describe("La contrainte / le changement."),
      },
    },
    async ({ projectId, constraint }) => {
      const userId = await uid();
      const tree = await projects.getProjectTree(userId, projectId);
      if (!tree) return fail("Projet introuvable.");
      await budgets.assertWithinBudget(projectId);
      const current: Architecture = {
        projectName: tree.name,
        summary: tree.idea ?? "",
        phases: tree.phases.map((ph) => ({
          name: ph.name,
          type: ph.type ?? "",
          tasks: ph.tasks.map((t) => ({
            title: t.title,
            description: t.description ?? "",
            mode: t.mode,
            priority: t.priority,
          })),
        })),
      };
      const profile = await profileMod.getProfile(userId);
      const startedAt = new Date();
      const result = await architect.refineArchitecture(
        tree.idea ?? tree.name,
        tree.type as ProjectType,
        current,
        constraint,
        profileMod.profilePreamble(profile),
      );
      await projects.replaceProjectTree(userId, projectId, result.architecture);
      await normes.autoAssociateProjectNorms(userId, projectId);
      await record(
        userId,
        `[raffinement] ${result.architecture.projectName}`,
        { projectId },
        result,
        startedAt,
      );
      return json(await projects.getProjectTree(userId, projectId));
    },
  );

  server.registerTool(
    "rename_project",
    {
      title: "Renommer un projet",
      inputSchema: { projectId: z.string(), name: z.string().min(1) },
    },
    async ({ projectId, name }) => {
      await projects.renameProject(await uid(), projectId, name);
      return json({ ok: true });
    },
  );

  server.registerTool(
    "delete_project",
    {
      title: "Supprimer un projet",
      description: "Supprime le projet et toute son arborescence. Irréversible.",
      inputSchema: { projectId: z.string() },
    },
    async ({ projectId }) => {
      await projects.deleteProject(await uid(), projectId);
      return json({ ok: true });
    },
  );

  server.registerTool(
    "set_project_budget",
    {
      title: "Plafond de tokens du projet",
      description:
        "Garde-fou : plafond de tokens par projet, vérifié avant chaque appel " +
        "LLM et à chaque étape d'un run. 0 = illimité.",
      inputSchema: { projectId: z.string(), maxTokens: z.number().int().min(0) },
    },
    async ({ projectId, maxTokens }) => {
      const userId = await uid();
      await budgets.setBudget(userId, projectId, maxTokens);
      return json(await budgets.getBudgetStatus(userId, projectId));
    },
  );

  // =====================================================================
  //  ARBRE — phases & tâches
  // =====================================================================

  server.registerTool(
    "add_phase",
    { title: "Ajouter une phase", inputSchema: { projectId: z.string(), name: z.string().min(1) } },
    async ({ projectId, name }) => {
      const id = await projects.addPhase(await uid(), projectId, name);
      return json({ phaseId: id });
    },
  );

  server.registerTool(
    "update_phase",
    {
      title: "Modifier une phase",
      inputSchema: {
        phaseId: z.string(),
        name: z.string().optional(),
        status: z.enum(["pending", "in_progress", "done"]).optional(),
      },
    },
    async ({ phaseId, name, status }) => {
      await projects.updatePhase(await uid(), phaseId, { name, status });
      return json({ ok: true });
    },
  );

  server.registerTool(
    "delete_phase",
    { title: "Supprimer une phase", inputSchema: { phaseId: z.string() } },
    async ({ phaseId }) => {
      await projects.deletePhase(await uid(), phaseId);
      return json({ ok: true });
    },
  );

  server.registerTool(
    "add_task",
    { title: "Ajouter une tâche", inputSchema: { phaseId: z.string(), title: z.string().min(1) } },
    async ({ phaseId, title }) => {
      const id = await projects.addTask(await uid(), phaseId, title);
      return json({ taskId: id });
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Modifier une tâche",
      description:
        "Change titre, statut, mode d'exécution (manual/cowork/autonomous) ou " +
        "priorité (0=P0 … 3=P3) d'une tâche.",
      inputSchema: {
        taskId: z.string(),
        title: z.string().optional(),
        status: z.enum(["todo", "in_progress", "blocked", "done"]).optional(),
        mode: z.enum(["manual", "cowork", "autonomous"]).optional(),
        priority: z.number().int().min(0).max(3).optional(),
      },
    },
    async ({ taskId, title, status, mode, priority }) => {
      await projects.updateTask(await uid(), taskId, { title, status, mode, priority });
      return json({ ok: true });
    },
  );

  server.registerTool(
    "delete_task",
    { title: "Supprimer une tâche", inputSchema: { taskId: z.string() } },
    async ({ taskId }) => {
      await projects.deleteTask(await uid(), taskId);
      return json({ ok: true });
    },
  );

  // =====================================================================
  //  TÂCHES — discussion (Manuel / Cowork) & livrables
  // =====================================================================

  server.registerTool(
    "send_task_message",
    {
      title: "Envoyer un message à une tâche",
      description:
        "Selon le mode de la tâche : MANUEL → réponse réactive de l'agent ; " +
        "COWORK → l'agent s'arrête et propose des options (point d'arrêt). " +
        "Utilise choose_cowork_option pour produire l'artefact ensuite. Appel LLM.",
      inputSchema: { taskId: z.string(), message: z.string().min(1) },
    },
    async ({ taskId, message }) => {
      const userId = await uid();
      const ctx = await conversation.getTaskContext(userId, taskId);
      if (!ctx) return fail("Tâche introuvable.");
      await budgets.assertWithinBudget(ctx.projectId);
      await conversation.addMessage(taskId, { role: "user", content: message });
      const hist = await history(userId, taskId);
      const norms = await normes.buildPhaseNormsContext(userId, ctx.phaseId);
      const startedAt = new Date();
      if (ctx.taskMode === "cowork") {
        const res = await agent.proposeCoworkOptions(ctx, hist, norms.text);
        await conversation.addMessage(taskId, {
          role: "assistant",
          content:
            res.data.intro +
            "\n\n" +
            res.data.options.map((o, i) => `${i + 1}. ${o.title} — ${o.detail}`).join("\n"),
          kind: "cowork_options",
          data: res.data,
        });
        await record(userId, `[cowork:options] ${ctx.taskTitle}`, { projectId: ctx.projectId, taskId }, res, startedAt);
        return json({ mode: "cowork", awaitingChoice: true, options: res.data });
      }
      const res = await agent.manualReply(ctx, hist, norms.text);
      await conversation.addMessage(taskId, { role: "assistant", content: res.text });
      await record(userId, `[manuel] ${ctx.taskTitle}`, { projectId: ctx.projectId, taskId }, res, startedAt);
      return json({ mode: "manual", reply: res.text });
    },
  );

  server.registerTool(
    "choose_cowork_option",
    {
      title: "Choisir une option Cowork → artefact",
      description:
        "Sur une tâche Cowork en attente de choix, sélectionne une option (index " +
        "0-based) : l'agent produit l'artefact (document Markdown) correspondant.",
      inputSchema: { taskId: z.string(), optionIndex: z.number().int().min(0) },
    },
    async ({ taskId, optionIndex }) => {
      const userId = await uid();
      const ctx = await conversation.getTaskContext(userId, taskId);
      if (!ctx) return fail("Tâche introuvable.");
      const status = await conversation.getCoworkStatus(userId, taskId);
      if (!status.awaitingChoice || !status.pendingOptions) {
        return fail("Aucune option en attente sur cette tâche.");
      }
      const option = status.pendingOptions.options[optionIndex];
      if (!option) return fail("Index d'option invalide.");
      await budgets.assertWithinBudget(ctx.projectId);
      await conversation.addMessage(taskId, {
        role: "user",
        content: `Choix : ${option.title}`,
        kind: "cowork_choice",
        data: { index: optionIndex },
      });
      const hist = await history(userId, taskId);
      const norms = await normes.buildPhaseNormsContext(userId, ctx.phaseId);
      const startedAt = new Date();
      const res = await agent.produceCoworkArtifact(ctx, hist, option, norms.text);
      const artifactId = await conversation.addArtifact(taskId, {
        type: "document",
        title: res.title,
        content: res.content,
      });
      await conversation.addMessage(taskId, {
        role: "assistant",
        content: `Artefact produit : « ${res.title} »`,
        kind: "artifact",
        data: { artifactId },
      });
      await record(userId, `[cowork:artefact] ${ctx.taskTitle}`, { projectId: ctx.projectId, taskId }, res, startedAt);
      return json({ artifactId, title: res.title, content: res.content });
    },
  );

  server.registerTool(
    "list_task_messages",
    {
      title: "Fil d'une tâche",
      description: "Historique complet des messages d'une tâche (dont journal des runs autonomes).",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => json(await conversation.listMessages(await uid(), taskId)),
  );

  server.registerTool(
    "list_task_artifacts",
    {
      title: "Livrables d'une tâche",
      description: "Artefacts d'une tâche : documents (Cowork) et widgets (visualisation).",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => json(await conversation.listArtifacts(await uid(), taskId)),
  );

  server.registerTool(
    "generate_widget",
    {
      title: "Générer un widget",
      description:
        "Produit un widget structuré (schéma Zod fixe : comparatif, checklist, " +
        "KPIs, callout, graphique) rendu par des composants whitelistés. Appel LLM.",
      inputSchema: { taskId: z.string(), instruction: z.string().min(1) },
    },
    async ({ taskId, instruction }) => {
      const userId = await uid();
      const ctx = await conversation.getTaskContext(userId, taskId);
      if (!ctx) return fail("Tâche introuvable.");
      await budgets.assertWithinBudget(ctx.projectId);
      const startedAt = new Date();
      const res = await widgets.generateWidget(instruction, ctx);
      await conversation.addArtifact(taskId, {
        type: "widget",
        title: res.widget.title,
        content: JSON.stringify(res.widget),
      });
      await record(userId, `[widget] ${res.widget.title}`, { projectId: ctx.projectId, taskId }, res, startedAt);
      return json(res.widget);
    },
  );

  // =====================================================================
  //  RUNS AUTONOMES — le cœur de l'exécution 100% autonome
  // =====================================================================

  server.registerTool(
    "launch_autonomous_run",
    {
      title: "Lancer un run autonome",
      description:
        "Met en file un run autonome : Claude Code travaille SEUL dans le " +
        "workspace du projet (modifie réellement les fichiers, sans commiter), " +
        "encadré par des garde-fous (itérations, plafond de tokens, timeout, kill " +
        "switch). Le worker draine la file automatiquement. Renvoie le runId — " +
        "suis-le avec get_run.",
      inputSchema: {
        taskId: z.string(),
        goal: z.string().min(1).describe("L'objectif que l'agent doit accomplir."),
        maxIterations: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Défaut : 1 (l'agent Claude Code boucle déjà en interne)."),
        maxTokens: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Plafond de tokens du run. Défaut 0 = illimité."),
        timeoutMin: z.number().int().min(1).max(120).optional().describe("Défaut : 30 min."),
      },
    },
    async ({ taskId, goal, maxIterations, maxTokens, timeoutMin }) => {
      const userId = await uid();
      const ctx = await conversation.getTaskContext(userId, taskId);
      if (!ctx) return fail("Tâche introuvable.");
      await budgets.assertWithinBudget(ctx.projectId);
      const runId = await runs.enqueueRun(userId, taskId, {
        goal,
        maxIterations: maxIterations ?? null,
        maxTokens: maxTokens ?? 0,
        timeoutMin: timeoutMin ?? null,
      });
      return json({
        runId,
        status: "queued",
        note: "Le worker prend le run en charge. Interroge get_run pour suivre.",
      });
    },
  );

  server.registerTool(
    "get_run",
    {
      title: "État d'un run",
      description:
        "État frais d'un run : status (queued/running/succeeded/failed/…), " +
        "itérations, tokens dépensés, raison d'arrêt, erreur éventuelle.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      const run = await runs.getRunFresh(runId);
      return run ? json(run) : fail("Run introuvable.");
    },
  );

  server.registerTool(
    "list_task_runs",
    {
      title: "Runs d'une tâche",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => json(await runs.listRunsForTask(await uid(), taskId)),
  );

  server.registerTool(
    "kill_run",
    {
      title: "Arrêter un run (kill switch)",
      description: "Demande l'arrêt coopératif d'un run en cours.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      await runs.requestKill(await uid(), runId);
      return json({ ok: true, killRequested: true });
    },
  );

  // =====================================================================
  //  NORMES — consignes réutilisables injectées en préprompt
  // =====================================================================

  server.registerTool(
    "list_normes",
    { title: "Lister les normes", inputSchema: {} },
    async () => json(await normes.listNormes(await uid())),
  );

  server.registerTool(
    "create_norme",
    {
      title: "Créer une norme",
      description:
        "Consigne réutilisable injectée en préprompt. Si sa catégorie == le type " +
        "d'une phase, elle est auto-associée aux projets à leur création.",
      inputSchema: {
        name: z.string().min(1),
        category: z
          .string()
          .optional()
          .describe("Ex: developpement, design, marketing. Pilote l'auto-association."),
        content: z.string().min(1).describe("Le texte injecté en préprompt."),
      },
    },
    async ({ name, category, content }) => {
      const id = await normes.createNorme(await uid(), {
        name,
        category: category ?? null,
        promptContent: content,
        scope: "global",
      });
      return json({ normeId: id });
    },
  );

  server.registerTool(
    "delete_norme",
    { title: "Supprimer une norme", inputSchema: { normeId: z.string() } },
    async ({ normeId }) => {
      await normes.deleteNorme(await uid(), normeId);
      return json({ ok: true });
    },
  );

  server.registerTool(
    "associate_norme",
    {
      title: "Associer une norme à une phase",
      description: "Rattache manuellement une norme à une phase (injection en préprompt).",
      inputSchema: { phaseId: z.string(), normeId: z.string() },
    },
    async ({ phaseId, normeId }) => {
      await normes.associateNorme(await uid(), phaseId, normeId, false);
      return json({ ok: true });
    },
  );

  // --- Boucle worker embarquée (autosuffisance) --------------------------
  const inlineWorker = process.env.MCP_INLINE_WORKER !== "0";
  if (inlineWorker) workerRuntime.startWorkerLoop();

  // --- Connexion stdio ----------------------------------------------------
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Rien de plus : le process reste vivant tant que le client MCP est connecté.
  // (Ne pas écrire sur stdout — réservé au protocole JSON-RPC.)
  console.error(
    `[mcp] orchestrato prêt — worker embarqué : ${inlineWorker ? "oui" : "non"}`,
  );
}

main().catch((err) => {
  console.error("[mcp] arrêt sur erreur fatale :", err);
  process.exit(1);
});
