# Tile Dominion

Jeu `.io` multijoueur de conquête en pixel art. Chaque joueur étend son territoire, développe une économie, commande des unités et construit des bastions afin de terminer la partie avec la plus grande domination territoriale.

## État actuel

Le projet est un MVP multijoueur jouable sur une instance serveur unique :

- salles de 50 joueurs logiques, humains et IA cumulés ;
- partie de 15 minutes sur une carte procédurale de 404×404 tuiles ;
- serveur autoritaire à 20 Hz et diffusion réseau par intérêt spatial à 10 Hz ;
- simulation persistante des joueurs, unités, combats, captures, production et ravitaillement dans un moteur Rust ;
- client Phaser avec interpolation, sélection d’unités, contrôles clavier et tactiles ;
- reconnexion Colyseus, validation des messages et limitation de débit ;
- comptes par nom d’utilisateur/mot de passe, score persistant et classement global ;
- protocole MessagePack compact entre Rust, Node et les clients.

L’état temps réel d’une partie reste en mémoire. Les comptes et scores utilisent la mémoire par défaut pour le développement, ou PostgreSQL avec `STORAGE_DRIVER=postgres`.

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

Ouvrir ensuite <http://localhost:5173>. Le serveur Colyseus écoute par défaut sur `http://localhost:2567` et expose `GET /health`, les routes d’authentification et le classement global.

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
| `STORAGE_DRIVER` | `memory` | Stockage des comptes : `memory` ou `postgres` |
| `DATABASE_URL` | — | Connexion PostgreSQL requise avec `STORAGE_DRIVER=postgres` |
| `MONITOR_DOMAIN` | — | Domaine HTTPS de Grafana en production |
| `GRAFANA_ADMIN_USER` | `admin` | Administrateur initial de Grafana |
| `GRAFANA_ADMIN_PASSWORD` | — | Mot de passe administrateur Grafana |
| `GRAFANA_PORT` | `3000` | Port local publié par Grafana |
| `ALERT_WEBHOOK_URL` | — | Webhook recevant les alertes Alertmanager |

## Comptes et classement global

Un compte se crée avec un nom d’utilisateur de 3 à 16 caractères et un mot de passe de 8 à 128 caractères. Les mots de passe ne sont jamais stockés en clair : le serveur conserve uniquement un dérivé `scrypt` salé. Le mode invité reste disponible, mais ne participe pas au classement global.

À la fin de chaque partie, chaque joueur authentifié encore représenté dans la salle reçoit :

```text
points = arrondi(tuiles possédées / tuiles capturables de la carte × 1000)
```

Une récompense est identifiée par la partie et le compte, ce qui rend une nouvelle tentative d’écriture sans risque de double crédit. Les routes HTTP disponibles sont :

Après l’attribution, la salle lance immédiatement une nouvelle partie de 15 minutes sur une nouvelle carte. Les clients et leurs comptes restent connectés, tandis que le monde, les IA, le moteur Rust et les caches réseau sont recréés.

- `POST /auth/register` avec `{ "username": "...", "password": "..." }` ;
- `POST /auth/login` avec les mêmes champs ;
- `GET /leaderboard` pour les 50 meilleurs scores.

Les sessions sont des jetons opaques valables 30 jours et conservés en mémoire par le processus serveur. Un redémarrage oblige donc à se reconnecter, sans perdre le compte ni le score lorsque PostgreSQL est activé.

## Règles et contrôles

- Déplacement du joueur : `WASD`, `ZQSD` ou flèches ; joystick sur mobile.
- La capture d’une tuile par le joueur demande 375 ms. Une tuile ennemie applique un multiplicateur ×3 et un robot un multiplicateur ×2.
- Chaque joueur vivant reçoit 5 crédits par seconde, même sans territoire. Le territoire fourni ajoute un revenu à rendement décroissant : 0,12 crédit par tuile jusqu’à 100, 0,07 de 101 à 300, puis 0,03 au-delà. Le territoire non fourni compte pour moitié puis se neutralise après 45 secondes.
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

Le joueur commence avec 80 crédits, 160 PV et les anciennes valeurs maximales de vitesse et de capture directement intégrées à ses statistiques de base. Les unités mobiles n’ont actuellement pas de plafond numérique configuré ; leurs coûts et le budget CPU constituent les limites pratiques. Un clic sur une case ouvre les trois choix de bâtiment : forteresse, usine ou relais.

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

## Déploiement Docker en production

La production utilise des services isolés :

- Caddy reçoit le trafic public sur les ports 80 et 443, obtient et renouvelle les certificats TLS et transmet les WebSockets ;
- Nginx sert le client compilé comme fichiers statiques avec un cache long pour les assets versionnés ;
- le serveur Node/Colyseus et son moteur Rust ne sont accessibles que depuis le réseau Docker ;
- PostgreSQL conserve les comptes et les scores dans le volume `tile_data`.
- Prometheus collecte les métriques, Alertmanager envoie les alertes, Loki centralise les logs et Grafana présente le tableau de bord.

Créer trois enregistrements DNS de type `A`/`AAAA` pointant vers le serveur, par exemple `game.example.com`, `api.game.example.com` et `monitor.game.example.com`. Les ports 80 et 443 doivent être accessibles depuis Internet. Préparer ensuite la configuration :

```bash
cp .env.production.example .env.production
```

Renseigner des domaines réels, l’adresse ACME et un mot de passe PostgreSQL robuste. `DATABASE_URL` doit contenir le même utilisateur et mot de passe que les variables PostgreSQL. Lancer enfin :

```bash
docker compose --env-file .env.production up -d --build
```

`VITE_SERVER_URL` est injectée pendant la construction de l’image client ; le navigateur utilise donc directement l’URL HTTPS publique de `API_DOMAIN`. Les connexions Colyseus deviennent automatiquement des WebSockets sécurisés derrière Caddy.

Les données TLS sont conservées dans `caddy_data`, la configuration Caddy dans `caddy_config` et PostgreSQL dans `tile_data`. Les volumes `prometheus_data`, `loki_data`, `alertmanager_data` et `grafana_data` conservent la supervision. Le serveur crée actuellement les tables `accounts` et `match_scores` au démarrage.

Pour suivre le déploiement :

```bash
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs -f proxy server
```

## Supervision

Le serveur écrit une ligne JSON par événement avec `timestamp`, `level`, `service` et `message`. Les événements de jeu incluent `roomId` et `matchId`, notamment pour la création des salles, les connexions, les fins de partie, les dépassements de tick et les erreurs Rust. Promtail ajoute les labels Docker et expédie ces journaux vers Loki.

`GET /metrics` expose à Prometheus :

- CPU, mémoire, heap, event loop et métriques Node standard ;
- salles, joueurs et connexions WebSocket actifs ;
- histogrammes de durée des ticks et des allers-retours Rust ;
- dépassements de budget, délais et crashs Rust ;
- erreurs HTTP et erreurs remontées par les navigateurs.

Cette route reste accessible sur le réseau Docker mais Caddy la masque sur l’API publique. Le client transmet les erreurs JavaScript et les promesses rejetées à `POST /client-errors`, avec les identifiants de salle et de partie lorsqu’ils sont connus.

`GET /health` effectue un `SELECT 1` réel dans PostgreSQL et une requête IPC réelle vers un moteur Rust dédié. Il répond `503` si un composant est indisponible ou pendant l’arrêt du serveur.

Prometheus déclenche des alertes pour une instance indisponible, un crash ou des délais Rust, un p95 de tick supérieur à 50 ms, une rafale de dépassements, une mémoire supérieure à 1,5 Go ou une rafale d’erreurs navigateur. Alertmanager les envoie vers `ALERT_WEBHOOK_URL`. Grafana est publié sur `MONITOR_DOMAIN` avec le dashboard **Tile Dominion — Production** préinstallé.

Dès que la stack Docker est lancée, Grafana est également disponible localement sur <http://localhost:3000>. Le port peut être changé avec `GRAFANA_PORT`. Il est lié uniquement à `127.0.0.1`, afin de ne pas contourner l’accès HTTPS du domaine de supervision sur un serveur public.

Sur `SIGTERM` ou `SIGINT`, Colyseus ferme les salles, les moteurs Rust, les sessions et PostgreSQL avant de quitter. Docker accorde 20 secondes avant de forcer l’arrêt.

## Limites avant production distribuée

- sessions partagées entre plusieurs processus (actuellement locales au processus) ;
- Redis Presence et coordination de plusieurs processus Colyseus ;
- matchmaking distribué et reprise d’une salle après panne ;
- traces distribuées entre plusieurs processus ;
- tests longue durée avec 50 clients réels, latence et pertes réseau ;
- découpage du bundle client, actuellement volumineux.
