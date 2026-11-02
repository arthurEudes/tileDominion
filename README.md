# Tile Dominion

Un jeu `.io` de conquête en pixel art : capturez des tuiles, financez robots et soldats, survivez et terminez la partie avec le plus grand territoire.

## Lancer

Prérequis : Node.js 22+ et npm. Copier `.env.example` vers `.env`, puis :

```bash
npm install
npm run dev
```

Ouvrir `http://localhost:5173`. Pour simuler une foule après le démarrage : `npm run bots`. Tests : `npm test`. Build : `npm run build`. Docker : `docker compose up --build`.

## Règles et contrôles

- WASD, ZQSD ou flèches ; espace pour attaquer. Joystick et bouton d'attaque sur mobile.
- Rester 550 ms sur une tuile adverse ou neutre la capture et rapporte 3 crédits.
- La boutique crée des robots collecteurs, des soldats, ou améliore vitesse, armure et capture.
- À la mort, le joueur réapparaît sur sa tuile la plus sûre. Sans territoire, il est éliminé.
- Serveur autoritaire à 20 Hz ; instantané d'intérêt spatial à 10 Hz ; partie de 10 minutes.

## Architecture

`apps/client` contient Phaser/Vite et la prédiction visuelle/interpolation. `apps/server` contient la salle Colyseus, les règles, IA et anti-spam. `apps/simulation-rust` conserve un état persistant des entités et de la carte, ordonnance les unités, acquiert leurs cibles et applique leurs décisions et déplacements. Après l'initialisation, Colyseus lui envoie uniquement les entités et tuiles modifiées ou supprimées par MessagePack cadré, puis applique les patches retournés. Tous les réglages viennent de `packages/game-config`, source unique de l'équilibrage. Node conserve les effets transactionnels (capture, dégâts, production, achats et respawn) et un tick TypeScript de secours si le sous-processus Rust devient indisponible.

Le stockage mémoire est le mode MVP. Le service PostgreSQL est préparé dans Compose (`--profile persistent`) ; l'adaptateur de comptes durable et Redis Presence sont les prochaines extensions avant production horizontale.

## État

Terminé : carte procédurale, obstacles, spawns espacés, mouvement validé, capture/économie, boutique, robots, soldats, combat, mort/respawn/élimination, invulnérabilité, leaderboard, chunks, reconnexion Colyseus, mobile, rate limit, bots, tests et Docker.

Restant pour une version production : comptes PostgreSQL et cosmétiques, écran de résultat enrichi, persistance de progression, Redis Presence, matchmaking multi-processus, métriques de charge et test mesuré à 20 joueurs. Aucune performance non mesurée n'est revendiquée.

Les principaux réglages se trouvent dans `packages/game-config/src/index.ts` : carte 64×64, 20 joueurs, capture 550 ms, capital 80, robot 45, soldat 70, plafonds de 5 unités de chaque type.
