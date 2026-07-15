# Orchestrato.AI

Plateforme de gestion de projet pilotée par **orchestration dynamique d'IA** : au lieu de cocher des tâches statiques, un routeur intelligent découpe une idée en phases, puis distribue le travail aux modèles d'IA les plus rentables et compétents selon la complexité et la taille du contexte.

Ce dépôt implémente jusqu'au **Milestone 5 (Bibliothèque de Normes/Skills)** :

- **M0** — walking skeleton (Next.js 15 / TS strict, schéma Drizzle, CI).
- **M1** — clés API multi-provider **chiffrées** (AES-256-GCM), routage + exécution réelle, **coût réel** journalisé dans `agent_executions`.
- **M2** — un **agent architecte** transforme une idée en langage naturel en arborescence `Projet → Phases → Tâches` (sortie structurée Zod), **éditable** depuis `/projects`.
- **M3** — **chat par tâche** avec bascule de mode : **Manuel** (réponse réactive, tier `fast`) et **Cowork** (l'agent propose des options, s'arrête sur un **point d'arrêt** persisté en base, puis produit un **`Artifact`** après le choix de l'utilisateur, tier `frontier`).
- **M4** — **mode Autonome (Full-Auto)** : une **queue durable en base** (`autonomous_runs`) + un **worker** (`npm run worker`) exécutent des runs en arrière-plan, avec **garde-fous vérifiés à chaque étape** (max itérations, plafond de coût, timeout, **kill switch**) et reprise après crash.
- **M5** — **bibliothèque de Normes/Skills** (`/normes`) : consignes réutilisables associées aux phases (auto par catégorie ↔ type de phase, ou manuellement) et **injectées en préprompt de façon traçable** dans tous les modes (Manuel, Cowork, Autonome).

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

Puis il sélectionne le meilleur provider **disponible** (clé fournie) selon un ordre de préférence par tier, exécute l'appel via l'AI SDK, et calcule le **coût réel** (tarification dans `lib/models.ts`) destiné à être journalisé dans la table `agent_executions` — la table de vérité du suivi budgétaire.

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

## Prochaine étape — Milestone 6

UI adaptative + widgets générés à la volée : mapping `phase.type → composant panneau`, widgets générés via schéma JSON structuré fixe (jamais de JSX/code exécuté côté client — risque XSS), rendus par composants React whitelistés (pattern « generative UI »).
