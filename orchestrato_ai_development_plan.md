# Plan de développement — Orchestrato.AI

## Contexte

Le dépôt `project-orchestrator` est actuellement vide (LICENSE, README quasi vide) hormis [orchestrato_ai_concept.md](orchestrato_ai_concept.md), qui décrit la vision d'Orchestrato.AI : une plateforme de gestion de projet pilotée par orchestration dynamique d'IA (routeur multi-modèles par coût/complexité, génération automatique de l'architecture de projet à partir d'une idée, agents en modes Autonome/Cowork/Manuel, bibliothèque de normes réutilisables, UI adaptative par phase).

Objectif de ce document : transformer cette vision en un plan de développement séquencé et réalisable par un développeur solo, à temps partiel, en TypeScript full-stack — en commençant par un MVP qui valide le cœur du produit avant d'étendre vers la vision complète. Ce plan est stratégique/technique ; il ne contient pas d'implémentation.

Décisions déjà validées avec l'utilisateur :
- **Approche** : MVP lean d'abord, puis extension progressive.
- **Stack** : Next.js/React (frontend + UI adaptative), Node.js/TypeScript (backend), PostgreSQL, framework d'orchestration d'agents (AI SDK + LangGraph.js).
- **Ressources** : développeur solo, projet personnel à temps partiel.

---

## A. Architecture technique cible (pragmatique pour un solo dev)

**Frontend + Backend** : un seul projet Next.js (App Router) pour commencer — Server Components/Server Actions pour l'API, Client Components pour les parties interactives (chat, streaming, éditeur de normes). Pas de séparation frontend/backend tant que ce n'est pas nécessaire.

**Moteur d'orchestration d'agents** : deux couches complémentaires, introduites progressivement pour ne pas payer leur complexité trop tôt :
- **Vercel AI SDK** dès M1 — abstraction unifiée multi-provider (Anthropic, OpenAI, Gemini, OpenRouter, Groq, Ollama), tool-calling structuré, streaming.
- **LangGraph.js** à partir de M3 seulement, quand un vrai besoin d'état de graphe/boucle/point d'arrêt (Cowork) apparaît.

**Routeur LLM (cœur produit)** : service applicatif interne — classification heuristique de complexité (longueur, type de tâche, mot-clé), sélection provider/modèle parmi les clés actives de l'utilisateur, appel via AI SDK, journalisation du coût réel dans `AgentExecution`.

**Stockage des clés API** : chiffrement applicatif AES-256-GCM, clé maître hors DB (secret manager de l'hébergeur), masquage systématique côté UI, filtrage des logs pour éviter toute fuite de clé via les stack traces des SDK providers.

**Jobs asynchrones (mode Autonome)** : le point d'architecture le plus structurant. Le mode Autonome dépasse les limites d'exécution serverless — nécessite une queue durable avec retries/reprise. Recommandation : **Trigger.dev** (ou Inngest), introduit seulement à M4 ; le MVP (M0-M3) reste synchrone.

**Schéma de données de haut niveau** :
```
User 1─N ApiKey            (provider, encryptedKey, label, lastUsedAt)
User 1─N Project           (name, type[tech|marketing], budgetLimitUsd)
Project 1─N Phase          (name, order, type, status)
Phase 1─N Task             (title, status, mode[autonomous|cowork|manual], priority)
Task 1─N AgentExecution    (provider, model, promptTokens, completionTokens, costUsd, status, mode)
Task 1─N Message           (role, content, createdAt)   -- fil cowork/manuel
Task 1─N Artifact          (type[document|widget|diagram], content/url)
User 1─N Norme             (name, category, promptContent, scope[global|project])
Phase N─N Norme            (via PhaseNormeAssociation: autoApplied bool)
Project 1─1 Budget         (limitUsd, spentUsd, period)
```
`AgentExecution` est la table de vérité pour le coût réel (suivi de l'optimisation financière). `Norme` est réutilisable inter-projets (scope global) ou spécifique (scope project).

---

## B. Jalons séquentiels (MVP → vision complète)

**Milestone 0 — Fondations + Walking Skeleton** *(≈1-2 semaines à temps partiel)*
Repo Next.js + TS strict, Postgres (Neon/Supabase) + Drizzle, auth basique (Auth.js), CI (lint/typecheck/build), déploiement Vercel, une page avec un bouton qui fait un vrai appel LLM en prod (clé en dur).
*Done* : connexion + appel LLM réel visible en prod. Valide la chaîne bout-en-bout avant d'investir dans le chiffrement/routage.

**Milestone 1 — Routeur d'Intelligence minimal**
CRUD `ApiKey` chiffrées, formulaire multi-provider, service de routage (règle simple complexité → modèle), appel réel à ≥2 providers, `AgentExecution` avec coût calculé.
*Done* : ajouter 2 clés, soumettre une tâche, voir le modèle choisi et le coût réel.

**Milestone 2 — Agent Architecte**
`Project`/`Phase`/`Task` en base, agent (tool-calling + schéma Zod) générant une arborescence de phases à partir d'une idée en langage naturel (tech/marketing), UI d'édition manuelle, régénération partielle sur changement de contrainte.
*Done* : une idée saisie produit une arborescence cohérente et éditable.

**Milestone 3 — Modes Manuel + Cowork (synchrones)**
Regroupés car même besoin d'infra (chat synchrone, pas de queue) contrairement au mode Autonome. Espace de discussion par tâche, mode Manuel réactif, mode Cowork avec point d'arrêt explicite (LangGraph.js, `interrupt`/checkpoint simple) — ex. proposer 3 options et attendre le choix utilisateur. Bascule au niveau de la tâche.
*Done* : sur une tâche, l'agent Cowork propose des options, l'utilisateur choisit, un `Artifact` est produit et sauvegardé.

**Milestone 4 — Mode Autonome (Full-Auto)**
Intégration Trigger.dev/Inngest, chaîne de tâches en arrière-plan (recherche web, rédaction, mise à jour de statut), garde-fous stricts (itérations max, plafond de coût, timeout, kill switch), notifications de fin de run.
*Done* : lancer un run Full-Auto, revenir plus tard, constater le résultat et le coût sans dépassement de budget.

**Milestone 5 — Bibliothèque de Normes/Skills**
CRUD `Norme` (contenu, catégorie, scope), association automatique par type de phase + manuelle, injection en préprompt au démarrage de la phase.
*Done* : une norme associée à une phase apparaît de façon traçable dans le contexte envoyé au LLM.

**Milestone 6 — UI adaptative + widgets générés à la volée**
Mapping `phase.type → composant panneau`, widgets générés via schéma JSON structuré fixe (jamais de JSX/code exécuté côté client — risque XSS), rendu par composants React whitelistés (pattern "generative UI").
*Done* : panneau contextuel visible par phase ; un widget structuré (tableau comparatif) s'affiche correctement.

**Milestone 7+ — Durcissement**
Budgets/alertes de dépassement, observabilité (Sentry + logs `AgentExecution`), multi-utilisateur si ouverture au-delà d'un usage perso, rate-limiting par provider, RAG/pgvector pour contexte long si le besoin se confirme.

---

## C. Risques techniques majeurs et mitigations

1. **Fiabilité du routage multi-provider** (formats d'erreur/rate limits différents) → retry/circuit-breaker, fallback vers un second provider, timeout explicite, tests d'intégration contre les vraies API.
2. **Gestion du contexte long** → n'injecter que le contexte pertinent (tâche + phase + normes), résumés progressifs, pgvector seulement si le besoin se confirme (pas anticipé).
3. **Sécurité du stockage des clés API** → chiffrement applicatif, clé maître hors DB, aucune clé en clair dans les logs, masquage UI systématique.
4. **Coût de dev de l'orchestration multi-agent** → ne pas introduire LangGraph.js avant M3, limites strictes non contournables dès le premier agent autonome.
5. **UI adaptative / widgets générés** → le LLM ne produit jamais de code exécutable, uniquement des données conformes à un schéma Zod fixe, rendu via composants whitelistés.
6. **Dérive budgétaire en mode Autonome** → plafond vérifié à chaque étape (pas seulement en fin de run), kill switch UI, alerting.

---

## D. Outillage recommandé (2026, solo dev)

| Besoin | Recommandation | Alternative |
|---|---|---|
| Auth | Auth.js (NextAuth v5) + adapter Postgres | Clerk |
| ORM | Drizzle ORM | Prisma |
| Queue jobs async | Trigger.dev v3 | Inngest / BullMQ+Upstash |
| Orchestration agents | Vercel AI SDK + LangGraph.js (dès M3) | Mastra |
| Hébergement app | Vercel | — |
| Workers longue durée | Trigger.dev Cloud | Railway/Fly.io |
| Base de données | Neon (Postgres serverless, pgvector) | Supabase |
| Validation de schémas | Zod | — |
| Observabilité | Sentry + logs structurés `AgentExecution` | — |
| UI kit | Tailwind + shadcn/ui | — |

---

## Premiers fichiers à créer (Milestone 0 → 1)

- `package.json` — setup Next.js + TS strict
- `drizzle/schema.ts` — schéma initial (User, ApiKey, Project, Phase, Task, AgentExecution)
- `lib/crypto.ts` — chiffrement AES-256-GCM des clés API
- `lib/llm-router.ts` — service de routage multi-provider au-dessus de l'AI SDK
- `.github/workflows/ci.yml` — pipeline CI (lint/typecheck/build)

## Vérification

Ce plan n'implique pas de code à ce stade. Chaque milestone ci-dessus définit son propre critère "Done" démontrable (déploiement réel, appel LLM réel, arborescence générée, run Autonome complet, etc.) — la validation se fait milestone par milestone en environnement réel (pas seulement via tests), conformément à l'esprit MVP lean du plan.
