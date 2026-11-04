# Tile Dominion

Jeu `.io` multijoueur de conquête en pixel art. Chaque joueur étend son territoire, développe une économie, commande des unités et construit des bastions afin de terminer la partie avec la plus grande domination territoriale.

## État actuel

Le projet est un MVP multijoueur jouable sur une instance serveur unique :

- salles de 50 joueurs logiques, humains et IA cumulés ;
- partie de 10 minutes sur une carte procédurale de 404×404 tuiles ;
- serveur autoritaire à 20 Hz et diffusion réseau par intérêt spatial à 10 Hz ;
- simulation persistante des joueurs, unités, combats, captures, production et ravitaillement dans un moteur Rust ;
- client Phaser avec interpolation, sélection d’unités, contrôles clavier et tactiles ;
- reconnexion Colyseus, validation des messages et limitation de débit ;
- protocole MessagePack compact entre Rust, Node et les clients.

L’état d’une partie est actuellement conservé en mémoire. Le dépôt prépare PostgreSQL dans Docker Compose, mais aucun adaptateur de comptes ou de progression persistante n’est encore branché.

## Prérequis

- Node.js 22 ou supérieur ;
- npm ;
- Rust stable et Cargo pour compiler le moteur de simulation ;
- Docker et Docker Compose, uniquement pour le lancement conteneurisé.

## Installation et lancement local

```bash
cp .env.example .env
npm install
npm run build:rust
npm run dev
```

Ouvrir ensuite <http://localhost:5173>. Le serveur Colyseus écoute par défaut sur `http://localhost:2567` et expose `GET /health`.

Le lancement de développement démarre simultanément :

- le serveur Node/Colyseus avec rechargement automatique ;
- le client Vite accessible sur le réseau local.

Le moteur Rust doit avoir été compilé au moins une fois. La commande ci-dessus le fait explicitement ; `npm run build`, `npm test` et `npm run benchmark` le font également automatiquement. Pour le recompiler seul :

```bash
npm run build:rust
```

## Commandes

| Commande | Fonction |
| --- | --- |
| `npm run dev` | Lance le serveur et le client en développement |
| `npm run build` | Compile Rust, TypeScript et le client Vite |
| `npm test` | Compile Rust puis exécute les tests Rust et serveur |
| `npm run test:rust` | Exécute uniquement les tests Rust |
| `npm run benchmark` | Exécute tous les benchmarks moteur, monde et pipeline réseau |
| `npm run bots` | Connecte des clients automatisés au serveur déjà démarré |
| `npm run start -w @tile/server` | Lance uniquement le serveur sans mode watch |

Le nombre de clients créés par `npm run bots` est contrôlé par `BOT_COUNT`. Ces clients de charge sont distincts des IA intégrées qui occupent les places libres de la salle.

## Configuration d’environnement

| Variable | Défaut | Utilisation |
| --- | --- | --- |
| `PORT` | `2567` | Port HTTP/WebSocket du serveur |
| `CLIENT_URL` | `http://localhost:5173` | Origine CORS autorisée |
| `VITE_SERVER_URL` | `http://localhost:2567` | Serveur ciblé par le client Vite |
| `SERVER_URL` | `http://localhost:2567` | Serveur ciblé par le script de bots externes |
| `BOT_COUNT` | `12` | Nombre de clients créés par `npm run bots` |
| `STORAGE_DRIVER` | `memory` | Réservé au futur adaptateur de stockage |
| `DATABASE_URL` | — | Préparé pour PostgreSQL, pas encore consommé par l’application |

## Règles et contrôles

- Déplacement du joueur : `WASD`, `ZQSD` ou flèches ; joystick sur mobile.
- La capture d’une tuile demande 550 ms de base. Une tuile ennemie applique un multiplicateur ×3 et un robot un multiplicateur ×2.
- Le territoire fourni rapporte des crédits chaque seconde. Le territoire non fourni rapporte moitié moins puis se neutralise après 45 secondes.
- Le joueur éliminé réapparaît sur sa tuile alliée la plus sûre. Sans territoire valide, il est éliminé.
- Les attaquants peuvent être sélectionnés individuellement ou par rectangle, puis recevoir un ordre de suivi, de garde ou d’attaque.
- Les IA remplacent les places humaines libres. Lorsqu’un humain rejoint une salle pleine d’IA, l’IA la plus faible est évincée.

### Économie et unités

| Élément | Prix | Rôle principal |
| --- | ---: | --- |
| Robot | 90 | Exploration et capture automatique |
| Soldat / attaquant | 140 | Combat mobile et ordres offensifs |
| Défenseur | 220 | Protection territoriale, 210 PV |
| Forteresse | 480 | Produit jusqu’à 8 défenseurs |
| Usine | 480 | Produit des robots |
| Relais | 480 | Étend la zone de ravitaillement |
| Mur | 90 | Bloque les déplacements, 750 PV |
| Tourelle | 420 | Attaque automatiquement à distance |

Le joueur commence avec 80 crédits. Les unités mobiles n’ont actuellement pas de plafond numérique configuré ; leurs coûts et le budget CPU constituent les limites pratiques. Les améliorations de vitesse, d’armure et de capture ont trois niveaux.

Les valeurs d’équilibrage de référence se trouvent dans `packages/game-config/src/index.ts`.

## Architecture

```text
apps/client              Phaser, Vite, rendu et interpolation
apps/server              Colyseus, salle, commandes, bots et projection réseau
apps/simulation-rust     simulation autoritaire et index spatial zoné
packages/game-config     réglages partagés et équilibrage
packages/protocol        schémas de messages et formats compacts
```

### Simulation

Rust conserve l’état autoritaire des joueurs et des unités. Le serveur Node lui transmet au démarrage la carte et les entités, puis uniquement les créations, suppressions, commandes et changements de tuiles.

Le monde est divisé en zones adaptatives. Les halos entre zones sont maintenus incrémentalement et l’accès à une unité par identifiant est direct. Le ciblage est parallélisé par zone, avec des fréquences de simulation adaptées à la distance et à l’activité.

En production, Rust ne renvoie plus la liste complète des schedules à chaque tick. Il retourne principalement :

- les événements transactionnels utiles à Node ;
- l’état compact des joueurs ;
- les deltas d’unités déjà encodés pour chaque cellule d’intérêt.

Le retour détaillé des schedules reste disponible pour les tests et les outils de diagnostic. Si le moteur Rust devient indisponible, Node possède encore un chemin de simulation TypeScript de secours.

### Réseau

Les clients sont regroupés par cellules d’intérêt de 16 tuiles. Une frame d’unités est calculée une fois par cellule dans Rust puis réutilisée pour tous les clients de cette cellule. Les snapshots globaux ne transportent que les joueurs pertinents, les tuiles modifiées, le leaderboard et les identifiants nécessaires.

Les identifiants d’unités et de propriétaires sont compactés en entiers stables pendant leur durée de vie. Le client conserve une palette globale issue du leaderboard afin que les unités gardent leur couleur même lorsque leur propriétaire se trouve hors de la zone visible.

## Benchmarks

Le benchmark complet compile Rust puis mesure :

1. le moteur et le transport IPC ;
2. le tick réel Rust→Node avec événements ;
3. l’encodage MessagePack, le décodage client et la diffusion multi-client.

```bash
npm run benchmark
```

Les charges sont configurables :

```bash
BENCH_COUNTS=1000,4000,8000 \
BENCH_PLAYERS=50 \
BENCH_CLIENTS=100 \
npm run benchmark
```

Variables disponibles : `BENCH_COUNTS`, `BENCH_PLAYERS`, `BENCH_CLIENTS`, `BENCH_TICKS`, `BENCH_WARMUP`, `BENCH_ITERATIONS`, `BENCH_IN_FLIGHT` et `BENCH_INTEREST_GROUPS`.

Les sous-benchmarks peuvent aussi être exécutés séparément :

```bash
npm run benchmark -w @tile/server
npm run benchmark:world -w @tile/server
npm run benchmark:pipeline -w @tile/server
```

Dernière mesure locale indicative, sans serveur de développement concurrent :

- monde de 8 032 unités et 20 joueurs simulés : moyenne 9,61 ms, p95 14,77 ms, p99 17,43 ms ;
- diffusion spatiale à 50 clients et 32 000 unités : p95 14,11 ms ;
- test IPC à 8 requêtes simultanées : aucune erreur ni expiration.

Ces chiffres dépendent de la machine et ne constituent pas une garantie de capacité en production. La salle accepte 50 joueurs, mais un test réseau mesuré avec 50 véritables clients simultanés reste nécessaire.

## Docker

Pour lancer le serveur et le client :

```bash
docker compose up --build
```

Pour démarrer également PostgreSQL :

```bash
docker compose --profile persistent up --build
```

Le conteneur PostgreSQL conserve ses données dans le volume `tile_data`, mais l’application continue actuellement d’utiliser la mémoire.

## Limites avant production distribuée

- comptes, authentification et progression persistante ;
- adaptateur PostgreSQL réellement utilisé par le serveur ;
- Redis Presence et coordination de plusieurs processus Colyseus ;
- matchmaking distribué et reprise d’une salle après panne ;
- observabilité durable : métriques, traces, alertes et historique de charge ;
- tests longue durée avec 50 clients réels, latence et pertes réseau ;
- découpage du bundle client, actuellement volumineux.
