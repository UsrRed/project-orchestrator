# Orchestrato.AI

Plateforme de gestion de projet pilotée par **orchestration dynamique d'IA** : au lieu de cocher des tâches statiques, un routeur intelligent découpe une idée en phases, puis distribue le travail aux modèles d'IA les plus rentables et compétents selon la complexité et la taille du contexte.

Ce dépôt implémente **l'intégralité des jalons du plan (M0 → M6)** :

- **M0** — walking skeleton (Next.js 15 / TS strict, schéma Drizzle, CI).
- **M1** — clés API multi-provider **chiffrées** (AES-256-GCM), routage + exécution réelle, **coût réel** journalisé dans `agent_executions`.
- **M2** — un **agent architecte** transforme une idée en langage naturel en arborescence `Projet → Phases → Tâches` (sortie structurée Zod), **éditable** depuis `/projects`.
- **M3** — **chat par tâche** avec bascule de mode : **Manuel** (réponse réactive, tier `fast`) et **Cowork** (l'agent propose des options, s'arrête sur un **point d'arrêt** persisté en base, puis produit un **`Artifact`** après le choix de l'utilisateur, tier `frontier`).
- **M4** — **mode Autonome (Full-Auto)** : une **queue durable en base** (`autonomous_runs`) + un **worker** (`npm run worker`) exécutent des runs en arrière-plan, avec **garde-fous vérifiés à chaque étape** (max itérations, plafond de coût, timeout, **kill switch**) et reprise après crash.
- **M5** — **bibliothèque de Normes/Skills** (`/normes`) : consignes réutilisables associées aux phases (auto par catégorie ↔ type de phase, ou manuellement) et **injectées en préprompt de façon traçable** dans tous les modes (Manuel, Cowork, Autonome).
- **M6** — **UI adaptative + widgets « generative UI »** : panneau contextuel par type de phase, et widgets générés via **schéma Zod fixe** (comparatif, checklist, KPIs, callout) rendus par des composants **whitelistés** — le modèle ne produit jamais de code exécutable (anti-XSS).

Voir [`orchestrato_ai_concept.md`](orchestrato_ai_concept.md) pour la vision fonctionnelle et [`orchestrato_ai_development_plan.md`](orchestrato_ai_development_plan.md) pour le plan de développement complet.

## Stack

- **Next.js 15** (App Router) — frontend + backend (Server Actions)
- **TypeScript strict**
- **Drizzle ORM** + **PostgreSQL** (Neon / Supabase)
- **Vercel AI SDK** — abstraction multi-provider (Anthropic, OpenAI, Google, OpenRouter, Groq)
- **Tailwind CSS**

## Structure

```
app/
  actions.ts          Server Actions : routeur + CRUD clés + journalisation
  page.tsx            Accueil : clés API, démo routeur, suivi du coût, jalons
  layout.tsx          Shell
  projects/
    page.tsx          Liste des projets + création par l'architecte
    actions.ts        Server Actions : génération + édition d'arborescence
    new-project-form.tsx  Formulaire client (idée → génération)
    [id]/page.tsx     Arborescence éditable d'un projet + normes par phase
  normes/
    page.tsx          Bibliothèque de normes (CRUD)
    actions.ts        Server Actions : création / suppression de normes
  tasks/
    [taskId]/page.tsx   Chat par tâche (fil + artefacts + runs) + bascule de mode
    [taskId]/actions.ts  Server Actions : envoi, choix Cowork, mode, runs
components/
  keys-manager.tsx    Formulaire client d'ajout/suppression de clés (masquées)
  router-demo.tsx     Formulaire client de test du routeur
  executions-list.tsx Historique + agrégats de coût réel
  auto-submit-select.tsx  <select> qui soumet au changement (édition inline)
  task-chat.tsx       Composeur client + boutons de choix Cowork
  autonomous-panel.tsx  Lancement de runs autonomes + kill switch
  phase-panel.tsx     Panneau adaptatif selon le type de phase (M6)
  widget-renderer.tsx Rendu whitelisté des widgets (anti-XSS) (M6)
  widget-generator.tsx  Formulaire client de génération de widget (M6)
scripts/
  worker.ts           Worker de fond : draine la queue autonomous_runs
  mcp-server.ts       Serveur MCP (stdio) : pilotage 100% autonome par un agent externe
drizzle/
  schema.ts           Schéma complet (User, ApiKey, Project, Phase, Task,
                      AgentExecution, Message, Artifact, Norme, Budget…)
  migrations/         Migrations SQL générées (drizzle-kit)
lib/
  crypto.ts           Chiffrement AES-256-GCM des clés API utilisateur
  db.ts               Connexion Drizzle / postgres.js
  users.ts            Bootstrap utilisateur local (mono-compte, avant Auth.js)
  keys.ts             CRUD clés chiffrées + déchiffrement serveur pour le routeur
  executions.ts       Persistance/lecture des exécutions (coût réel)
  architect.ts        Agent architecte : idée → arborescence (schéma Zod)
  projects.ts         Persistance + édition des projets/phases/tâches
  conversation.ts     Fil par tâche, artefacts, état de la machine Cowork
  agent.ts            Agent conversationnel (Manuel/Cowork) via le routeur
  runs.ts             Queue durable des runs autonomes (claim SKIP LOCKED)
  worker.ts           Exécuteur de run + garde-fous (fonction d'étape injectable)
  autonomous-agent.ts Câblage de production du worker (étape LLM réelle)
  cli-agent.ts        Câblage du moteur `cli` : lance un agent de code réel
  cli-agents.ts       Registre claude/gemini/opencode (args + parsing, pur)
  cli-availability.ts Détection des CLI installés (PATH)
  process.ts          Unique site de spawn : kill de groupe, timeout, env filtré
  workspace.ts        Workspaces disque : clone/init du dépôt d'un projet
  intelligence.ts     Niveau d'intelligence par modèle (table curée + dérivation)
  normes.ts           CRUD normes, association par phase, préprompt traçable
  widgets.ts          Schéma Zod fixe des widgets + parsing sécurisé (M6)
  models.ts           Catalogue de modèles + tarification (calcul du coût réel)
  llm-router.ts       Routeur : classification heuristique → sélection → appel
```

> **Note d'architecture (M3)** — le point d'arrêt Cowork est une machine à états
> **persistée en base** (la conversation est déjà durable). LangGraph.js n'est
> pas introduit tant qu'un vrai graphe multi-nœuds n'est pas nécessaire, pour
> limiter le coût d'orchestration (risque #4 du plan).

## Démarrage

```bash
# 1. Installer les dépendances
npm install

# 2. Configurer l'environnement
cp .env.example .env
#    - DATABASE_URL           : Postgres (Neon/Supabase)
#    - ENCRYPTION_MASTER_KEY  : openssl rand -base64 32

# 3. Appliquer le schéma en base
npm run db:generate   # génère les migrations SQL depuis drizzle/schema.ts
npm run db:migrate    # les applique (non-interactif ; db:push exige un TTY)

# 4. Lancer en dev
npm run dev
```

Puis, depuis la page d'accueil : **ajoutez une ou plusieurs clés API** (stockées chiffrées). Sans clé, le routeur affiche la **décision de routage** (provider, modèle, tier, raison) en dry-run, sans consommer de tokens. Avec au moins une clé, le routeur déclenche un **appel réel** et journalise le **coût calculé** dans l'historique.

## Le routeur d'intelligence & coût

Le classifieur heuristique (`lib/llm-router.ts`) choisit un *tier* :

- **fast** — tâches simples / faible contexte (traduction, formatage, validation) → modèles économiques (Groq Llama, Gemini Flash, GPT-4o-mini…)
- **frontier** — tâches complexes / grand contexte (recherche, architecture, code) → modèles haut de gamme (Claude 3.5 Sonnet, GPT-4o, Gemini 1.5 Pro…)

Un **modèle local** (LM Studio / Ollama, OpenAI-compatible via `LOCAL_AI_BASE_URL`) est pris en charge comme provider `ollama` : coût nul, donc **préféré par le routeur** quand une connexion locale est enregistrée. Toute la chaîne (routage, architecte, chat, Cowork, runs autonomes, widgets) a été validée de bout en bout contre un modèle local (qwen3-coder-30b).

**Connecteurs multi-méthodes** — chaque provider se connecte via une **méthode** ([lib/providers.ts](lib/providers.ts)) : `api_key` (clé API), `oauth` (jeton Bearer collé, obtenu hors-app) ou `none` (serveur local, sans credential). Le secret est stocké chiffré ; le routeur construit le client en conséquence (clé, `Authorization: Bearer`, ou local). L'OAuth-token est fiable pour les endpoints OpenAI-compatibles ; pour Anthropic/Google la voie « sans clé » officielle reste **Vertex/Bedrock** (les logins abonnement type Gemini CLI / Claude Code utilisent des clients OAuth privés et ne sont pas répliqués).

**Catalogue complet des modèles** (inspiration OpenCode) — la liste des modèles et leurs **tarifs** proviennent de **models.dev** ([lib/model-catalog.ts](lib/model-catalog.ts), snapshot embarqué `lib/models.dev.json` + rafraîchissement live). Dès qu'un provider est connecté, **tous ses modèles** sont disponibles (14–300 selon le provider), listés sur `/models` ; les modèles du serveur local sont lus via son endpoint `/v1/models`. Le routeur choisit par tier (fast = le moins cher, frontier = le plus haut de gamme) et calcule le coût avec les tarifs du catalogue ; connexion épurée (provider + clé) sur l'accueil.

**Fiabilité (M7.1)** — tous les appels LLM passent par `runWithFallback` ([lib/llm-router.ts](lib/llm-router.ts)) : timeout par tentative, retry (SDK), **fallback multi-provider** (parcours de la chaîne de préférence du tier), **circuit-breaker** léger (saute un provider qui échoue en série) et **rate-limiting par provider** ([lib/rate-limit.ts](lib/rate-limit.ts), `ollama` local exempté).

Puis il sélectionne le meilleur provider **disponible** (clé fournie) selon un ordre de préférence par tier, exécute l'appel via l'AI SDK, et calcule le **coût réel** (tarification dans `lib/models.ts`) destiné à être journalisé dans la table `agent_executions` — la table de vérité du suivi budgétaire.

## Observabilité (M7.4)

Logs **structurés** (JSON : level/event/contexte) via [lib/observability.ts](lib/observability.ts) ; les échecs d'exécutions et de runs sont journalisés et **remontés à Sentry si `SENTRY_DSN` est défini** (sinon no-op, l'app tourne sans compte Sentry — init dans [instrumentation.ts](instrumentation.ts)). Un tableau de bord **`/health`** montre le taux d'échec des exécutions, le coût total, la répartition des runs par statut et les derniers incidents.

## Budgets & alertes (M7.3)

Chaque exécution LLM est rattachée à son projet (`agent_executions.project_id`). Sur la page projet, un **budget** (`limitUsd`) peut être fixé : le montant dépensé est calculé en direct depuis la table de vérité, avec **alerte à 80 %** et **blocage à 100 %** — les appels IA (chat, Cowork, widget) et le **lancement de runs autonomes** sont refusés au dépassement, et un run en cours s'arrête avec la raison `project_budget`. Service : [lib/budgets.ts](lib/budgets.ts).

## Profils & navigation

- **Profil** (`/profile`) — préférences par compte ([lib/profile.ts](lib/profile.ts)) : langue et **ton** des réponses IA, **type de projet** et **budget** par défaut, provider préféré. La langue/le ton sont injectés en préambule de l'**agent architecte** ; le budget par défaut est appliqué aux nouveaux projets.
- **Navigation partagée** ([components/top-nav.tsx](components/top-nav.tsx)) — barre en tête de toutes les pages (Projets / Normes / Modèles / Santé / Profil + compte).
- **Raffinement de l'architecte** — sur la page projet, « Affiner l'arborescence » régénère phases et tâches selon une **contrainte** ([lib/architect.ts](lib/architect.ts) `refineArchitecture`). Une **barre de progression** (tâches terminées) figure sur `/projects` et la page projet.

## Authentification (M7.2)

Auth.js v5 + **GitHub OAuth** (adapter Drizzle) : config Edge-safe ([auth.config.ts](auth.config.ts)) + config Node avec adapter ([auth.ts](auth.ts)), middleware de protection ([middleware.ts](middleware.ts)), page `/signin`. Tout le code étant scopé par `userId`, seul `getCurrentUserId()` ([lib/users.ts](lib/users.ts)) lit la session.

- **Configuration sans `.env`** : la page **`/setup`** ouvre le formulaire GitHub *pré-rempli* (nom, homepage, **callback URL**), puis on colle le Client ID/Secret. Ils sont stockés **chiffrés en base** ([lib/oauth-config.ts](lib/oauth-config.ts)) et le provider s'active **dynamiquement, sans redémarrage** ([auth.ts](auth.ts) en config fonction). `AUTH_SECRET` reste requis ; `AUTH_GITHUB_ID/SECRET` en env sont un repli optionnel.
- **Enforcement** : callback OAuth = `<origin>/api/auth/callback/github` ; les non-authentifiés sont redirigés vers `/signin`.
- **Développement** : `ALLOW_DEV_USER="true"` (ou `NODE_ENV !== 'production'`) ouvre l'accès et utilise un **utilisateur local** — pratique pour le dev et les scripts/worker (hors contexte requête).

## Scripts

| Script | Rôle |
|---|---|
| `npm run dev` | Serveur de développement |
| `npm run build` | Build de production |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (config Next) |
| `npm test` | Suite de tests (vitest : unitaires + intégration DB) |
| `npm run worker` | Worker du mode Autonome (draine la queue en arrière-plan) |
| `npm run mcp` | Serveur MCP (stdio) : pilotage 100% autonome par un agent externe |
| `npm run db:generate` | Génère les migrations SQL depuis le schéma |
| `npm run db:migrate` | Applique les migrations (non-interactif) |
| `npm run db:studio` | Explorateur de base Drizzle |

## Tests

**vitest** ([vitest.config.ts](vitest.config.ts)) :
- `tests/unit.test.ts` — sans base : crypto, routeur & fiabilité (fallback, circuit-breaker, rate-limit, timeout), parsing de widgets (anti-XSS), mapping de panneau.
- `tests/integration.test.ts` — contre un Postgres réel : clés chiffrées, arborescence de projet & édition, conversation/Cowork, normes, runs autonomes & garde-fous (dont `project_budget`), budgets, config OAuth chiffrée.

Lancer : `npm test` (charge `.env` ; nécessite le Postgres de dev migré).

## CI

`.github/workflows/ci.yml` : job **build** (lint + typecheck + build) et job **test** (service Postgres → `db:migrate` → `npm test`) sur chaque push/PR vers `main`.

## Mode Autonome — comment ça tourne

La queue est **maison** (Postgres + worker), sans service externe :

1. Depuis une tâche (`/tasks/[id]`), lancer un run avec un objectif et des garde-fous (max itérations, plafond de coût, timeout).
2. Le run est mis en file (`autonomous_runs`, statut `queued`).
3. Le **worker** (`npm run worker`, processus séparé) réclame le run (`FOR UPDATE SKIP LOCKED`), l'exécute par itérations, vérifie les garde-fous **à chaque étape**, persiste coût et progression, produit un `Artifact`, puis notifie la fin (statut + raison d'arrêt).
4. Un **kill switch** dans l'UI arrête un run en cours ; un worker qui crashe laisse le run repris automatiquement (verrou périmé).

## Serveur MCP — piloter l'orchestrateur à 100% en autonome

L'orchestrateur s'expose comme **serveur MCP** ([scripts/mcp-server.ts](scripts/mcp-server.ts),
transport stdio) : un agent externe (Claude Code, Claude Desktop, un cron
autonome…) gère **tout le cycle d'un projet** sans passer par l'UI web — créer
l'arborescence, l'éditer, discuter les tâches (Manuel / Cowork), **lancer des
runs autonomes**, suivre leur état et lire les livrables.

```bash
npm run mcp        # démarre le serveur (tsx --conditions=react-server, comme le worker)
```

Deux traits le rendent autosuffisant :

- il parle à la **même base** que le web (mêmes fonctions `lib/`) — ce qu'un
  agent crée par MCP apparaît dans l'UI, et inversement ;
- il **héberge lui-même la boucle worker** : un run mis en file par
  `launch_autonomous_run` s'exécute même sans serveur web. Le claim est atomique
  (`FOR UPDATE SKIP LOCKED`), donc ce worker et le worker web/dédié coexistent
  sans double traitement. Poser `MCP_INLINE_WORKER=0` pour déléguer l'exécution
  au web / `npm run worker`.

Le dépôt fournit un [`.mcp.json`](.mcp.json) : un Claude Code lancé à la racine
découvre le serveur automatiquement. Outils exposés (26) :

| Domaine | Outils |
| --- | --- |
| Projets | `list_projects`, `create_project`, `get_project`, `refine_project`, `rename_project`, `delete_project`, `set_project_budget` |
| Arbre | `add_phase`, `update_phase`, `delete_phase`, `add_task`, `update_task`, `delete_task` |
| Tâches (Manuel/Cowork) | `send_task_message`, `choose_cowork_option`, `list_task_messages`, `list_task_artifacts`, `generate_widget` |
| Runs autonomes | `launch_autonomous_run`, `get_run`, `list_task_runs`, `kill_run` |
| Normes | `list_normes`, `create_norme`, `delete_norme`, `associate_norme` |

Boucle type d'un agent 100% autonome : `create_project` (idée → arborescence) →
`get_project` (lire les ids) → `update_task` (passer les tâches en `autonomous`)
→ `launch_autonomous_run` par tâche → `get_run` en polling → `list_task_artifacts`
pour récupérer les livrables. L'utilisateur (repli local hors requête) et les
garde-fous de budget/itérations/timeout s'appliquent exactement comme via l'UI.

## Niveau d'intelligence & routage

Chaque modèle du catalogue porte un **niveau d'intelligence** sur 5 crans —
`0 basique · 1 standard · 2 avancé · 3 expert · 4 frontière` — et c'est **l'axe
du routage** ([lib/intelligence.ts](lib/intelligence.ts)).

**models.dev ne publie aucun score de capacité** : ces niveaux sont donc
produits ici, par deux voies complémentaires.

1. **Table curée par famille** — models.dev regroupe les modèles en familles
   stables (`claude-opus`, `gpt-nano`, `gemini-flash`…). La table encode ce
   qu'on sait de ces familles ; c'est une **correction là où le prix ment**
   (un Haiku à 1 $ n'est pas « standard », un DeepSeek de raisonnement à 0,43 $
   non plus).
2. **Dérivation par signaux** — pour tout le reste : prix pondéré, raisonnement,
   contexte, âge. Les familles **hétérogènes** en relèvent volontairement
   (`gpt` couvre 45 modèles de 0,50 $ à 30 $ : un niveau unique y serait faux).

Deux ajustements s'appliquent quelle que soit l'origine du niveau, parce qu'ils
décrivent le modèle et non la méthode : une **petite variante** (`-mini`,
`-nano`, `-lite`) perd un cran, et un modèle de **plus de 18 mois** aussi — le
prix des anciens modèles ne baisse pas quand l'état de l'art avance, et sans ça
un GPT-4o de 2024 à 5 $ est dérivé « frontière » et gagne le mode boost.

Répartition actuelle sur les 459 modèles routables : 51 % niveau issu de la
table, 49 % dérivé.

### Politique de sélection

- **Par défaut** — le **moins cher qui atteint le niveau requis** par la tâche
  (`fast` ≥ 2, `frontier` ≥ 3, cf. `TIER_MIN_LEVEL`), en essayant d'abord les
  modèles à 0 $. On ne paie pas un modèle frontière pour ce qu'un modèle avancé
  traite.
- **Boost** (case à cocher, démo routeur et runs autonomes) — le **plus capable**
  d'abord, tous providers confondus, le moins cher départageant les ex æquo.
  Les gratuits n'y gardent pas la priorité : sinon un gratuit atteignant tout
  juste le plancher gagnerait toujours et le mode ne servirait à rien.
- Un provider **sans modèle assez capable est sauté** plutôt que de fournir un
  repli au rabais (Groq n'a rien de niveau expert → il ne sert pas les tâches
  `frontier`). Un fallback ne doit pas dégrader la tâche en silence.

Les tiers `fast`/`frontier` restent l'API du routeur : ils ne désignent plus un
prix mais un **niveau minimum requis**.

> ⚠️ Ces niveaux sont des **estimations datées**, pas des mesures. La table
> reflète ce qui était su en 2026-07 et doit être révisée ; l'UI marque d'un
> `~` les niveaux déduits.

Le **modèle local** (LM Studio / Ollama) est inconnaissable : on le suppose
niveau 3 pour qu'il reste utilisable partout comme avant. Ajuste avec
`LOCAL_AI_LEVEL` si le modèle chargé est plus faible (ou plus fort).

Le catalogue est par ailleurs filtré de ce qui n'est pas routable — modèles
retirés, non textuels (image/audio), embeddings — car la sélection « le plus
cher » pouvait élire un générateur d'images comme haut de gamme d'un provider.

## Moteur « agent CLI » — faire écrire du code

Un run autonome choisit son **moteur** :

- **`llm`** (défaut, historique) — le routeur appelle un modèle qui produit des
  données conformes à un schéma Zod. Il ne touche à aucun fichier.
- **`cli`** — le worker lance un **agent de code** (`claude`, `gemini`,
  `opencode`) dans un **clone du dépôt du projet**. L'agent boucle avec ses
  propres outils et **modifie réellement les fichiers**.

Le moteur `cli` **rompt délibérément l'invariant** « le modèle ne produit jamais
de code exécutable » qui tient partout ailleurs dans l'app. Le confinement
repose sur quatre choses, et **ce n'est pas une sandbox** — l'agent a les droits
de l'utilisateur du worker :

- un workspace par projet (`.workspaces/<projectId>`, cf. `WORKSPACES_DIR`),
  **toujours un dépôt git à sa racine** — sinon git remonterait jusqu'au dépôt
  de l'orchestrateur et l'agent piloterait le code de l'app ;
- les modes de permission du CLI (`acceptEdits` / `auto_edit`), jamais
  `--dangerously-skip-permissions` ni `--yolo` ;
- **aucun commit, aucun push** : l'agent modifie l'arbre de travail, le diff est
  résumé dans l'`Artifact` et c'est toi qui relis ;
- timeout, plafond d'itérations et **kill switch effectif pendant l'invocation**
  (le run est relu toutes les 2 s ; à l'arrêt, tout le groupe de processus est
  tué, pas seulement le fils).

**Prérequis** : le CLI doit être installé **et connecté** sur la machine du
worker. Il utilise son propre login (abonnement) : aucune clé de l'app ne lui
est transmise — l'environnement est filtré par une allowlist, précisément pour
qu'une `ANTHROPIC_API_KEY` traînant dans le `.env` ne fasse pas basculer Claude
Code sur la facturation à la clé.

`/models` les liste sous « Abonnements — agents CLI », à part des providers :
un agent CLI **n'est pas routable**, le mélanger aux providers laisserait croire
que le chat ou l'architecte peuvent s'en servir. « Détecté » y signifie
**binaire présent**, pas « authentifié » — le vérifier demanderait de lancer
l'agent (coûteux) ou de lire ses credentials (hors de question) ; un login
expiré ne se voit donc qu'au premier run.

État constaté des trois agents (machine de dev, 2026-07-16) :

| CLI | État | Coût remonté |
|---|---|---|
| `claude` | vérifié de bout en bout | **oui** (`total_cost_usd`) |
| `opencode` | vérifié ; exige `OPENCODE_CLI_MODEL` (sans modèle explicite, il ne rend jamais la main) | oui (0 sur les modèles gratuits) |
| `gemini` | **indisponible** : Google a retiré Code Assist « individuals » à ce client (`IneligibleTierError`). Code écrit et testé sur fixtures, non vérifié en réel. | non |

Un CLI qui ne remonte pas de coût rend le **plafond de coût du run aveugle** :
seuls les itérations et le timeout le bornent. L'UI le dit au moment du choix.

## État & suites possibles

Tous les jalons M0–M6 du plan sont implémentés et validés. Pistes de
durcissement (Milestone 7+ du plan) : authentification multi-utilisateur
(Auth.js), budgets/alertes de dépassement, observabilité (Sentry + logs
`AgentExecution`), rate-limiting par provider, RAG/pgvector pour contexte long.
