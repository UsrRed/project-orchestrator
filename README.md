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

Un **modèle local** (LM Studio / Ollama, OpenAI-compatible via `LOCAL_AI_BASE_URL`) est pris en charge comme provider `ollama` : coût nul, donc **préféré par le routeur** quand une clé locale est enregistrée. Toute la chaîne (routage, architecte, chat, Cowork, runs autonomes, widgets) a été validée de bout en bout contre un modèle local (qwen3-coder-30b).

**Fiabilité (M7.1)** — tous les appels LLM passent par `runWithFallback` ([lib/llm-router.ts](lib/llm-router.ts)) : timeout par tentative, retry (SDK), **fallback multi-provider** (parcours de la chaîne de préférence du tier), **circuit-breaker** léger (saute un provider qui échoue en série) et **rate-limiting par provider** ([lib/rate-limit.ts](lib/rate-limit.ts), `ollama` local exempté).

Puis il sélectionne le meilleur provider **disponible** (clé fournie) selon un ordre de préférence par tier, exécute l'appel via l'AI SDK, et calcule le **coût réel** (tarification dans `lib/models.ts`) destiné à être journalisé dans la table `agent_executions` — la table de vérité du suivi budgétaire.

## Observabilité (M7.4)

Logs **structurés** (JSON : level/event/contexte) via [lib/observability.ts](lib/observability.ts) ; les échecs d'exécutions et de runs sont journalisés et **remontés à Sentry si `SENTRY_DSN` est défini** (sinon no-op, l'app tourne sans compte Sentry — init dans [instrumentation.ts](instrumentation.ts)). Un tableau de bord **`/health`** montre le taux d'échec des exécutions, le coût total, la répartition des runs par statut et les derniers incidents.

## Budgets & alertes (M7.3)

Chaque exécution LLM est rattachée à son projet (`agent_executions.project_id`). Sur la page projet, un **budget** (`limitUsd`) peut être fixé : le montant dépensé est calculé en direct depuis la table de vérité, avec **alerte à 80 %** et **blocage à 100 %** — les appels IA (chat, Cowork, widget) et le **lancement de runs autonomes** sont refusés au dépassement, et un run en cours s'arrête avec la raison `project_budget`. Service : [lib/budgets.ts](lib/budgets.ts).

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
| `npm run worker` | Worker du mode Autonome (draine la queue en arrière-plan) |
| `npm run db:generate` | Génère les migrations SQL depuis le schéma |
| `npm run db:migrate` | Applique les migrations (non-interactif) |
| `npm run db:studio` | Explorateur de base Drizzle |

## CI

`.github/workflows/ci.yml` exécute lint + typecheck + build sur chaque push/PR vers `main`.

## Mode Autonome — comment ça tourne

La queue est **maison** (Postgres + worker), sans service externe :

1. Depuis une tâche (`/tasks/[id]`), lancer un run avec un objectif et des garde-fous (max itérations, plafond de coût, timeout).
2. Le run est mis en file (`autonomous_runs`, statut `queued`).
3. Le **worker** (`npm run worker`, processus séparé) réclame le run (`FOR UPDATE SKIP LOCKED`), l'exécute par itérations, vérifie les garde-fous **à chaque étape**, persiste coût et progression, produit un `Artifact`, puis notifie la fin (statut + raison d'arrêt).
4. Un **kill switch** dans l'UI arrête un run en cours ; un worker qui crashe laisse le run repris automatiquement (verrou périmé).

## État & suites possibles

Tous les jalons M0–M6 du plan sont implémentés et validés. Pistes de
durcissement (Milestone 7+ du plan) : authentification multi-utilisateur
(Auth.js), budgets/alertes de dépassement, observabilité (Sentry + logs
`AgentExecution`), rate-limiting par provider, RAG/pgvector pour contexte long.
