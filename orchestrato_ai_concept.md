# Orchestrato.AI — Spécifications Fonctionnelles & Concept du Projet

## 1. Vision Globale
**Orchestrato.AI** est une plateforme de gestion de projet d'un nouveau genre, où le pilotage ne se fait plus par des tâches statiques à cocher, mais par une **orchestration dynamique d'intelligences artificielles**. 

La plateforme agit comme un chef d'orchestre intelligent qui :
1. Connecte l'ensemble de vos modèles d'IA (payants, gratuits, locaux).
2. Découpe n'importe quelle idée de projet en phases et tâches adaptées.
3. Distribue intelligemment le travail aux IA les plus rentables et compétentes.
4. Permet de collaborer de manière fluide avec des agents autonomes, semi-autonomes ou manuels.

---

## 2. Le Cœur du Système : Le Routeur d'Intelligence & Coût

La gestion des ressources est optimisée automatiquement selon deux critères clés : **le niveau de complexité** et **la taille du contexte (tokens)**.

* **Fédération de Clés API :** L'utilisateur connecte ses propres clés de manière sécurisée (Anthropic Claude, Google Gemini, OpenAI, OpenRouter, Groq, etc.).
* **Modèles Gratuits & Open-Source :** Possibilité d'intégrer des modèles gratuits (via des API gratuites, Hugging Face, ou des instances locales comme Ollama).
* **Routage Dynamique et Intelligent :**
  * *Tâches simples / faible contexte* (ex: traduire un court texte, formater du JSON, valider une syntaxe) $\rightarrow$ Redirection vers un modèle gratuit ou ultra-rapide (ex: Gemini Flash, Llama 3).
  * *Tâches complexes / grand contexte* (ex: analyser un cahier des charges de 50 pages, concevoir une architecture logicielle) $\rightarrow$ Redirection vers un modèle haut de gamme (ex: Claude 3.5 Sonnet, GPT-4o).
* **Contrôle Budgétaire :** L'utilisateur peut définir des budgets par projet et suivre l'optimisation financière réalisée grâce au routage intelligent.

---

## 3. Génération Dynamique de l'Architecture de Projet

Contrairement aux outils de gestion de projet traditionnels (Trello, Jira) où l'utilisateur doit tout créer lui-même, Orchestrato.AI génère la structure de projet sur-mesure à partir d'une simple idée de départ.

* **L'Agent Architecte :** L'utilisateur saisit son idée (ex: *"Je veux créer une application mobile de troc de plantes"*). Un agent spécialisé analyse l'idée et génère instantanément les phases indispensables au projet.
* **Phases sur-mesure :** L'architecture du projet n'est pas figée. Elle s'adapte à la nature du projet :
  * *Projet Tech :* R&D, Benchmark technique, Spécifications, UX/UI, Prototypage, Développement, QA/Test, Déploiement.
  * *Projet Marketing :* Analyse de marché, Stratégie éditoriale, Création graphique, Plan de lancement.
* **Évolution en temps réel :** Si l'utilisateur change d'avis ou ajoute une contrainte en cours de route, l'architecture du projet se réorganise dynamiquement (les étapes s'adaptent, s'ajoutent ou fusionnent).

---

## 4. Modes de Collaboration des Agents IA

Chaque tâche ou phase du projet est assignée à un ou plusieurs agents IA. L'utilisateur peut régler le niveau d'autonomie de ces agents selon son besoin de contrôle :

1. **Mode Autonome (Full-Auto) :**
   * L'agent travaille en arrière-plan. Il enchaîne les tâches, fait des recherches sur le web, rédige des documents et met à jour l'état du projet sans solliciter l'utilisateur.
   * *Exemple :* L'agent effectue un benchmark complet des concurrents, rédige le rapport et passe la tâche à l'étape suivante.
2. **Mode Collaboratif (Cowork - Human-in-the-loop) :**
   * L'agent avance de manière autonome mais s'arrête à des points stratégiques pour demander l'avis, des précisions ou la validation de l'utilisateur.
   * *Exemple :* L'agent génère trois propositions d'arborescence UX pour l'application, les présente à l'utilisateur, attend son retour et ses choix pour continuer le travail de conception.
3. **Mode Manuel :**
   * L'agent agit comme un conseiller ou un copilote réactif. Il n'entreprend rien de lui-même et attend les instructions directes de l'utilisateur dans un espace de discussion dédié.

---

## 5. Interface Dynamique & Normes Personnalisées (Skills & Preprompts)

Pour garantir la qualité et le respect des normes (techniques, graphiques, ou de rédaction), la plateforme repose sur un système d'interface et de règles totalement modulaire.

### Bibliothèque de Normes et Compétences (Skills & Preprompts)
* **Création de "Normes" :** L'utilisateur peut enregistrer des chartes ou des guides méthodologiques.
  * *Norme Tech :* "Écrire du code en TypeScript strict, documenter chaque fonction, utiliser Tailwind CSS".
  * *Norme UX :* "Toujours concevoir pour le Mobile-First, respecter le contraste d'accessibilité WCAG".
  * *Norme R&D :* "Toujours citer au moins 3 sources scientifiques pour chaque affirmation".
* **Association aux Phases :** Ces normes sont automatiquement ou manuellement associées aux phases correspondantes. Lorsque l'IA démarre la phase "Développement", la norme technique associée est automatiquement injectée dans son contexte (preprompt).

### Interface Utilisateur Adaptative et Dynamique
* L'interface graphique de la plateforme n'est pas uniforme ; elle s'adapte à la phase en cours de traitement.
* **Composants Contextuels :**
  * *Phase R&D :* L'interface affiche un panneau de recherche académique, des cartes de synthèse d'articles et des fils de sources d'information.
  * *Phase UX/UI :* L'interface fait apparaître une visionneuse de maquettes (type wireframes générés), des palettes de couleurs et des retours utilisateurs.
  * *Phase Développement :* L'interface se transforme pour afficher des blocs de code, des logs d'erreurs et un terminal virtuel où l'on voit l'agent tester son code.
* **Widgets Générés à la Volée :** Selon le type de livrable attendu, l'IA peut elle-même suggérer et faire apparaître des widgets de visualisation spécifiques (tableaux comparatifs interactifs, graphiques de données, diagrammes de flux).
