# Orchestrato.AI

Plateforme de gestion de projet pilotée par **orchestration dynamique d'IA** : au lieu de cocher des tâches statiques, un routeur intelligent découpe une idée en phases, puis distribue le travail aux modèles d'IA les plus rentables et compétents selon la complexité et la taille du contexte.

Ce dépôt implémente jusqu'au **Milestone 2 (Agent Architecte)** :

- **M0** — walking skeleton (Next.js 15 / TS strict, schéma Drizzle, CI).
- **M1** — clés API multi-provider **chiffrées** (AES-256-GCM), routage + exécution réelle, **coût réel** journalisé dans `agent_executions`.
- **M2** — un **agent architecte** transforme une idée en langage naturel en arborescence `Projet → Phases → Tâches` (sortie structurée Zod), **éditable** (ajout/renommage/statut/mode/priorité/suppression) depuis `/projects`.

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
    [id]/page.tsx     Arborescence éditable d'un projet
components/
  keys-manager.tsx    Formulaire client d'ajout/suppression de clés (masquées)
  router-demo.tsx     Formulaire client de test du routeur
  executions-list.tsx Historique + agrégats de coût réel
  auto-submit-select.tsx  <select> qui soumet au changement (édition inline)
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
  models.ts           Catalogue de modèles + tarification (calcul du coût réel)
  llm-router.ts       Routeur : classification heuristique → sélection → appel
```

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
| `npm run db:generate` | Génère les migrations SQL depuis le schéma |
| `npm run db:migrate` | Applique les migrations (non-interactif) |
| `npm run db:studio` | Explorateur de base Drizzle |

## CI

`.github/workflows/ci.yml` exécute lint + typecheck + build sur chaque push/PR vers `main`.

## Prochaine étape — Milestone 3

Modes Manuel + Cowork (synchrones) : espace de discussion par tâche, mode Manuel réactif, mode Cowork avec point d'arrêt explicite (LangGraph.js `interrupt`/checkpoint) — l'agent propose des options, l'utilisateur choisit, un `Artifact` est produit et sauvegardé.
