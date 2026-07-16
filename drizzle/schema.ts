/**
 * Schéma de données Orchestrato.AI (Milestone 0 → 1).
 *
 * Reflète le schéma de haut niveau du plan de développement :
 *   User 1─N ApiKey / Project / Norme
 *   Project 1─N Phase, 1─1 Budget
 *   Phase 1─N Task, N─N Norme (via PhaseNormeAssociation)
 *   Task 1─N AgentExecution / Message / Artifact
 *
 * `agent_execution` est la table de vérité pour le coût réel (suivi de
 * l'optimisation financière du routage).
 */
import { relations } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// --- Enums ---------------------------------------------------------------

/**
 * Providers d'exécution journalisés dans `agent_executions`.
 *
 * Les 7 premiers sont les providers LLM du routeur (type `Provider` de
 * [lib/models.ts](../lib/models.ts)). Les `*_cli` sont les agents CLI du moteur
 * `cli` ([lib/cli-agents.ts](../lib/cli-agents.ts)) : ce ne sont pas des appels
 * API mais des processus lancés sous le login du CLI. Les distinguer évite de
 * confondre un run `claude` sur abonnement avec un appel API `anthropic` dans
 * la lecture du coût.
 */
export const providerEnum = pgEnum("provider", [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "opencode",
  "groq",
  "ollama",
  "claude_cli",
  "gemini_cli",
  "opencode_cli",
]);

export const projectTypeEnum = pgEnum("project_type", ["tech", "marketing"]);

/** Rattachement d'un projet à un dépôt Git : aucun (local) ou dépôt GitHub. */
export const repoModeEnum = pgEnum("repo_mode", ["local", "github"]);

export const phaseStatusEnum = pgEnum("phase_status", [
  "pending",
  "in_progress",
  "done",
]);

export const taskStatusEnum = pgEnum("task_status", [
  "todo",
  "in_progress",
  "blocked",
  "done",
]);

export const taskModeEnum = pgEnum("task_mode", [
  "autonomous",
  "cowork",
  "manual",
]);

export const executionStatusEnum = pgEnum("execution_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
]);

export const messageRoleEnum = pgEnum("message_role", [
  "system",
  "user",
  "assistant",
  "tool",
]);

export const artifactTypeEnum = pgEnum("artifact_type", [
  "document",
  "widget",
  "diagram",
]);

export const normeScopeEnum = pgEnum("norme_scope", ["global", "project"]);

export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

// --- Colonnes communes ---------------------------------------------------

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// --- Tables --------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  // Colonnes attendues par Auth.js (adapter Drizzle).
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
  ...timestamps,
});

/**
 * Configuration OAuth de l'application (creds de l'app auprès du provider),
 * saisie depuis /setup plutôt que via l'env. Le secret est stocké CHIFFRÉ
 * (AES-256-GCM, lib/crypto). Une ligne par provider.
 */
export const oauthConfig = pgTable("oauth_config", {
  provider: text("provider").primaryKey(),
  clientId: text("client_id").notNull(),
  clientSecretEnc: text("client_secret_enc").notNull(),
  ...timestamps,
});

// --- Tables Auth.js (adapter Drizzle) ------------------------------------

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.providerAccountId] }),
  }),
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.identifier, t.token] }),
  }),
);

/**
 * Connecteurs LLM de l'utilisateur (table historiquement « api_keys »).
 * Chaque ligne = une connexion à un provider, selon une `method` :
 *  - 'api_key' / 'oauth' : secret CHIFFRÉ dans `encrypted_key` (clé ou jeton) ;
 *  - 'none' : aucune credential (serveur local) → `encrypted_key` nul.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    /** Méthode de connexion : 'api_key' | 'oauth' | 'none'. */
    method: text("method").notNull().default("api_key"),
    label: text("label"),
    /** Secret chiffré (clé API ou jeton OAuth). Nul pour la méthode 'none'. */
    encryptedKey: text("encrypted_key"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => ({
    byUserProvider: uniqueIndex("api_keys_user_provider_label_uq").on(
      t.userId,
      t.provider,
      t.label,
    ),
  }),
);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  idea: text("idea"),
  type: projectTypeEnum("type").notNull().default("tech"),
  budgetLimitUsd: numeric("budget_limit_usd", { precision: 12, scale: 4 }),
  // --- Rattachement Git (M7) ---
  repoMode: repoModeEnum("repo_mode").notNull().default("local"),
  /** `owner/repo` du dépôt lié (null en mode local). */
  repoFullName: text("repo_full_name"),
  repoUrl: text("repo_url"),
  /** Visibilité connue du dépôt lié — privé par défaut à la création. */
  repoPrivate: boolean("repo_private").notNull().default(true),
  ...timestamps,
});

export const phases = pgTable("phases", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type"),
  order: integer("order").notNull().default(0),
  status: phaseStatusEnum("status").notNull().default("pending"),
  ...timestamps,
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  phaseId: uuid("phase_id")
    .notNull()
    .references(() => phases.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  status: taskStatusEnum("status").notNull().default("todo"),
  mode: taskModeEnum("mode").notNull().default("manual"),
  priority: integer("priority").notNull().default(0),
  ...timestamps,
});

/** Table de vérité du coût réel de chaque appel LLM. */
export const agentExecutions = pgTable("agent_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * Tâche d'origine. Nullable : en M1, le routeur est exécuté de façon
   * autonome (playground), avant l'existence des `Task` liées à un projet (M2).
   */
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  /** Projet rattaché (pour le suivi budgétaire). Nullable (playground routeur). */
  projectId: uuid("project_id").references(() => projects.id, {
    onDelete: "cascade",
  }),
  /** Utilisateur propriétaire de l'exécution (suivi du coût par compte). */
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Libellé lisible de la requête routée (prompt tronqué, type de tâche). */
  taskLabel: text("task_label"),
  provider: providerEnum("provider").notNull(),
  model: text("model").notNull(),
  tier: text("tier"),
  mode: taskModeEnum("mode").notNull().default("manual"),
  status: executionStatusEnum("status").notNull().default("pending"),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
    .notNull()
    .default("0"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  ...timestamps,
});

/** Fil de discussion cowork/manuel d'une tâche. */
export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  role: messageRoleEnum("role").notNull(),
  content: text("content").notNull(),
  /**
   * Nature du message pour le rendu et la machine à états Cowork :
   * 'text' (défaut), 'cowork_options' (l'agent propose des options et attend),
   * 'cowork_choice' (l'utilisateur a choisi), 'artifact' (un artefact a été produit).
   */
  kind: text("kind").notNull().default("text"),
  /** Charge structurée éventuelle (ex: liste d'options Cowork, réf. d'artefact). */
  data: jsonb("data"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  type: artifactTypeEnum("type").notNull(),
  title: text("title"),
  /** Contenu inline (document/widget JSON) ou URL externe. */
  content: text("content"),
  url: text("url"),
  ...timestamps,
});

/** Normes / Skills réutilisables (chartes, guides méthodo) injectées en préprompt. */
export const normes = pgTable("normes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  promptContent: text("prompt_content").notNull(),
  scope: normeScopeEnum("scope").notNull().default("global"),
  /** Renseigné seulement si scope = 'project'. */
  projectId: uuid("project_id").references(() => projects.id, {
    onDelete: "cascade",
  }),
  ...timestamps,
});

/** Association N─N Phase ↔ Norme, avec application automatique éventuelle. */
export const phaseNormeAssociations = pgTable(
  "phase_norme_associations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phaseId: uuid("phase_id")
      .notNull()
      .references(() => phases.id, { onDelete: "cascade" }),
    normeId: uuid("norme_id")
      .notNull()
      .references(() => normes.id, { onDelete: "cascade" }),
    autoApplied: boolean("auto_applied").notNull().default(false),
  },
  (t) => ({
    uq: uniqueIndex("phase_norme_uq").on(t.phaseId, t.normeId),
  }),
);

export const budgets = pgTable("budgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: "cascade" }),
  limitUsd: numeric("limit_usd", { precision: 12, scale: 4 }).notNull(),
  spentUsd: numeric("spent_usd", { precision: 12, scale: 6 })
    .notNull()
    .default("0"),
  period: text("period").notNull().default("total"),
  ...timestamps,
});

/**
 * Profil / préférences de l'utilisateur (une ligne par compte). Personnalise
 * le comportement de l'IA (langue, ton, type de projet par défaut) et fournit
 * des valeurs par défaut (budget, provider préféré).
 */
export const profiles = pgTable("profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  language: text("language").notNull().default("fr"),
  tone: text("tone").notNull().default("neutre et professionnel"),
  defaultProjectType: projectTypeEnum("default_project_type")
    .notNull()
    .default("tech"),
  preferredProvider: providerEnum("preferred_provider"),
  defaultBudgetUsd: numeric("default_budget_usd", { precision: 12, scale: 4 }),
  /**
   * Ordre de préférence des sources du routage autonome, en CSV
   * (« local,subscription,free »). Cf. [lib/sources.ts](../lib/sources.ts).
   *
   * Une colonne texte plutôt qu'un tableau PG : la valeur est lue en bloc,
   * jamais requêtée par élément, et `parseSourceOrder` la répare de toute façon
   * — un type plus strict n'achèterait aucune garantie ici.
   */
  sourceOrder: text("source_order"),
  ...timestamps,
});

/**
 * Runs du mode Autonome — sert AUSSI de queue durable : les lignes `queued`
 * sont réclamées par le worker (`FOR UPDATE SKIP LOCKED`), les `running`
 * peuvent être reprises après un crash. Garde-fous vérifiés à chaque itération :
 * plafond de coût, nombre max d'itérations, timeout, kill switch.
 */
/**
 * Relevés de l'usage d'abonnement Claude (`claude -p "/usage"`).
 *
 * **Pas de `user_id`, et ce n'est pas un oubli** : le quota appartient au login
 * `claude` de la machine, pas à un compte de l'app. Il est partagé par tous les
 * utilisateurs et inclut la consommation faite hors de l'app. Y coller un
 * `user_id` laisserait croire à une ventilation par compte qui n'existe pas.
 *
 * Une ligne = un relevé. Les pourcentages viennent du serveur d'Anthropic ; on
 * ne les recalcule pas, on les horodate pour pouvoir comparer avant/après.
 */
export const claudeUsageSamples = pgTable("claude_usage_samples", {
  id: uuid("id").primaryKey().defaultRandom(),
  capturedAt: timestamp("captured_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * Limites relevées : `[{ key, label, percentUsed, resetsAt }]`.
   *
   * `jsonb` plutôt que des colonnes fixes : les limites exposées dépendent du
   * plan (la ligne « Fable » n'existe pas partout) et bougeront avec le CLI.
   * Une colonne par limite obligerait à migrer à chaque changement d'offre.
   */
  limits: jsonb("limits").notNull(),
  /** Runs actifs à l'instant du relevé : distingue « pendant » de « au repos ». */
  activeRuns: integer("active_runs").notNull().default(0),
});

export const autonomousRuns = pgTable("autonomous_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  goal: text("goal").notNull(),
  status: runStatusEnum("status").notNull().default("queued"),
  /**
   * Moteur d'exécution : `auto` (résolu par le worker d'après le niveau estimé
   * et l'ordre de sources du profil — le défaut), `llm` (routeur AI SDK) ou
   * `cli` (agent CLI lancé dans le workspace du projet).
   *
   * `text` plutôt qu'un enum PG assumé : le registre des CLI bougera plus vite
   * que les migrations, et `providerEnum` montre déjà le coût d'un enum à
   * garder aligné à trois endroits.
   */
  engine: text("engine").notNull().default("auto"),
  /** Quel CLI quand `engine = 'cli'` : claude | gemini | opencode. */
  engineCli: text("engine_cli"),
  /**
   * Mode « boost » : router vers le modèle le plus capable au lieu du moins
   * cher atteignant le niveau requis. Ne concerne que `engine = 'llm'` (un
   * agent CLI choisit son modèle lui-même).
   */
  boost: boolean("boost").notNull().default(false),
  /**
   * Niveau d'intelligence requis, estimé par l'IA à la planification (0-4).
   * NULL tant que le run n'a pas été planifié.
   */
  plannedLevel: integer("planned_level"),
  /** Justification du plan (niveau + limites), affichée à l'utilisateur. */
  planReason: text("plan_reason"),
  /** `ai` | `heuristic` — ne pas faire passer une estimation pour une mesure. */
  planner: text("planner"),
  /** Source retenue par le routage : local | subscription | free | paid. */
  sourceKind: text("source_kind"),
  /** Étiquette lisible de la source retenue (« Abonnement — Claude Code »). */
  sourceLabel: text("source_label"),
  /**
   * Garde-fous. `NULL` = « à faire estimer par l'IA » ; une valeur = l'utilisateur
   * a ouvert « Limites » et imposé la sienne, que la planification ne touche pas.
   */
  maxIterations: integer("max_iterations"),
  /**
   * Plafond de dépense. **0 est une valeur légitime** et le défaut : « n'entame
   * pas mon crédit », donc local/abonnement/gratuit uniquement. À ne pas
   * confondre avec un plafond atteint — cf. `guardStop` dans worker.ts.
   */
  maxCostUsd: numeric("max_cost_usd", { precision: 12, scale: 6 })
    .notNull()
    .default("0"),
  /** Minutes demandées. NULL = à estimer. `timeoutAt` en découle au démarrage. */
  timeoutMin: integer("timeout_min"),
  timeoutAt: timestamp("timeout_at", { withTimezone: true }),
  killRequested: boolean("kill_requested").notNull().default(false),
  /** Progression. */
  iterations: integer("iterations").notNull().default(0),
  spentUsd: numeric("spent_usd", { precision: 12, scale: 6 })
    .notNull()
    .default("0"),
  /** Verrou de worker (claim) : horodatage de prise en charge. */
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  /** Raison d'arrêt : completed | budget | iterations | timeout | killed | error. */
  stopReason: text("stop_reason"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  ...timestamps,
});

// --- Relations -----------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  apiKeys: many(apiKeys),
  projects: many(projects),
  normes: many(normes),
  executions: many(agentExecutions),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, { fields: [apiKeys.userId], references: [users.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  user: one(users, { fields: [projects.userId], references: [users.id] }),
  phases: many(phases),
  budget: one(budgets),
}));

export const phasesRelations = relations(phases, ({ one, many }) => ({
  project: one(projects, {
    fields: [phases.projectId],
    references: [projects.id],
  }),
  tasks: many(tasks),
  normeAssociations: many(phaseNormeAssociations),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  phase: one(phases, { fields: [tasks.phaseId], references: [phases.id] }),
  executions: many(agentExecutions),
  messages: many(messages),
  artifacts: many(artifacts),
}));

export const agentExecutionsRelations = relations(
  agentExecutions,
  ({ one }) => ({
    task: one(tasks, {
      fields: [agentExecutions.taskId],
      references: [tasks.id],
    }),
    user: one(users, {
      fields: [agentExecutions.userId],
      references: [users.id],
    }),
  }),
);

export const messagesRelations = relations(messages, ({ one }) => ({
  task: one(tasks, { fields: [messages.taskId], references: [tasks.id] }),
}));

export const artifactsRelations = relations(artifacts, ({ one }) => ({
  task: one(tasks, { fields: [artifacts.taskId], references: [tasks.id] }),
}));

export const normesRelations = relations(normes, ({ one, many }) => ({
  user: one(users, { fields: [normes.userId], references: [users.id] }),
  project: one(projects, {
    fields: [normes.projectId],
    references: [projects.id],
  }),
  phaseAssociations: many(phaseNormeAssociations),
}));

export const phaseNormeAssociationsRelations = relations(
  phaseNormeAssociations,
  ({ one }) => ({
    phase: one(phases, {
      fields: [phaseNormeAssociations.phaseId],
      references: [phases.id],
    }),
    norme: one(normes, {
      fields: [phaseNormeAssociations.normeId],
      references: [normes.id],
    }),
  }),
);

export const budgetsRelations = relations(budgets, ({ one }) => ({
  project: one(projects, {
    fields: [budgets.projectId],
    references: [projects.id],
  }),
}));

export const autonomousRunsRelations = relations(autonomousRuns, ({ one }) => ({
  user: one(users, {
    fields: [autonomousRuns.userId],
    references: [users.id],
  }),
  task: one(tasks, {
    fields: [autonomousRuns.taskId],
    references: [tasks.id],
  }),
}));
