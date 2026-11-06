# Tile Dominion — brief de conception des doctrines

## Objet du document

Ce document décrit l'état actuel de Tile Dominion et un problème de game design encore non résolu : comment proposer trois orientations stratégiques réellement distinctes avant une partie, sans que les doctrines « Expansion » et « Industrie » produisent exactement la même façon de jouer.

Il ne s'agit pas encore d'une spécification définitive. Les valeurs et mécaniques proposées sont des hypothèses à critiquer, équilibrer et simplifier.

## Présentation du jeu

Tile Dominion est un jeu `.io` multijoueur de conquête territoriale en pixel art. Une partie dure actuellement 15 minutes sur une carte procédurale de 404 × 404 cases. Une salle contient 50 joueurs logiques, humains et IA cumulés.

Le joueur contrôle directement un personnage qui capture des cases en restant dessus. Il développe ensuite son territoire avec des unités et des bâtiments :

- robot : capture automatiquement les cases ;
- attaquant : combat et reçoit des ordres offensifs ;
- défenseur : protège une zone ;
- forteresse : produit des défenseurs ;
- usine : produit des robots ;
- relais : étend le réseau de ravitaillement.

Le serveur est autoritaire. La simulation principale tourne dans un moteur Rust, avec Colyseus/Node pour les salles, comptes et messages réseau, et Phaser côté client.

## Économie actuelle

Le joueur commence avec 80 crédits et reçoit toutes les secondes :

- 5 crédits de base ;
- 0,12 crédit par case jusqu'à 100 cases ;
- 0,07 crédit par case entre 101 et 300 ;
- 0,03 crédit par case au-delà.

Le territoire non ravitaillé rapporte moitié moins, puis devient neutre après 45 secondes. Les relais servent donc à maintenir les zones éloignées.

Prix actuels :

| Élément | Prix | Fonction |
| --- | ---: | --- |
| Robot | 90 | Capture automatique |
| Attaquant | 140 | Combat et assaut |
| Défenseur | 220 | Protection territoriale |
| Forteresse | 480 | Production de défenseurs |
| Usine | 480 | Production de robots |
| Relais | 480 | Extension du ravitaillement |

L'économie territoriale utilise des rendements décroissants afin de limiter l'effet boule de neige, mais posséder davantage de cases reste la principale source de revenus.

## Progression et fin de partie

Les comptes possèdent un score persistant, un pays et un record personnel de territoire. L'écran final affiche maintenant :

- le gagnant et le classement de la partie ;
- les places gagnées ou perdues dans les classements pays et monde ;
- le territoire maximal ;
- les cases capturées et perdues ;
- les éliminations, unités et bâtiments produits ;
- un graphique de l'évolution du territoire ;
- le record personnel ;
- une progression cosmétique ;
- les actions Rejouer, Changer de mode et Quitter.

Il n'existe encore aucune classe ou doctrine jouable.

## Idée initiale

Le joueur choisirait avant chaque partie une doctrine qui lui donne des bonus temporaires valables uniquement pendant cette partie :

1. Expansion : capture et robots ;
2. Industrie : revenus et production ;
3. Guerre : soldats et siège.

Le choix précédent pourrait rester présélectionné, mais le joueur serait libre d'en changer à chaque partie. Les doctrines ne doivent pas créer de progression permanente de puissance ni de pay-to-win.

## Problème principal

Dans les règles actuelles, Expansion et Industrie sont mécaniquement corrélées :

```text
plus de territoire
    → plus de revenus
    → plus de bâtiments et d'unités
    → encore plus de territoire
```

Donner à Expansion un bonus de capture et à Industrie un bonus de revenus ne suffit donc probablement pas. Les deux doctrines chercheraient toujours à capturer le maximum de cases le plus vite possible, puis utiliseraient le même surplus économique pour produire les mêmes unités.

Le joueur percevrait trois noms différents, mais seulement deux styles réels : économie/conquête et combat.

## Différenciation recherchée

La distinction envisagée est la suivante :

| Axe | Expansion | Industrie |
| --- | --- | --- |
| Philosophie | Jouer large | Jouer dense |
| Ressource stratégique | Espace et mobilité | Bâtiments et rendement local |
| Forme du territoire | Étendue, ramifiée, plusieurs fronts | Compacte, fortifiée, organisée autour de centres |
| Puissance | Rapide et immédiate | Retardée mais croissante |
| Unité emblématique | Robot | Usine |
| Décision principale | Où ouvrir le prochain front ? | Où construire la prochaine chaîne ? |
| Vulnérabilité | Lignes de ravitaillement fragiles | Temps et investissement nécessaires à l'installation |

Le test fondamental serait :

- un joueur Expansion doit pouvoir être puissant avec beaucoup de territoire et peu de bâtiments ;
- un joueur Industrie doit pouvoir rivaliser avec moins de territoire grâce à un complexe très productif.

## Hypothèse A — Expansion/Pionnier

Cette doctrine gagnerait grâce au contrôle de la carte et non grâce à un bonus direct de revenus.

Bonus envisagés :

- robots 10 à 15 % moins chers ;
- capture des cases neutres 15 à 20 % plus rapide ;
- robots 10 % plus rapides ;
- portée des relais supérieure de 20 à 25 % ;
- aucune remise sur les bâtiments de production ;
- aucun bonus de revenu passif.

Mécanique exclusive possible : **Élan frontalier**.

Capturer régulièrement de nouvelles cases remplit une jauge. Tant que le joueur continue sa progression, ses robots gagnent de la vitesse ou ses relais coûtent moins cher. La jauge diminue après quelques secondes sans nouvelle capture.

Cette mécanique doit encourager le mouvement et les décisions géographiques, sans devenir une simple machine à générer de l'argent.

## Hypothèse B — Industrie/Forge

Cette doctrine gagnerait grâce à la densité, aux bâtiments et aux chaînes de production, pas grâce à la vitesse de capture.

Bonus envisagés :

- bâtiments 8 à 10 % moins chers ;
- usines et forteresses 15 à 20 % plus rapides ;
- réparation lente des bâtiments ravitaillés ;
- rendement industriel fourni par un nombre limité de bâtiments actifs ;
- aucun bonus de capture ;
- aucun bonus de vitesse des robots.

Mécanique exclusive possible : **Chaîne industrielle**.

Des bâtiments proches, connectés et ravitaillés créent des synergies :

- usine + relais : production accélérée ;
- usine + forteresse : petite réduction du coût des unités ;
- plusieurs bâtiments autour d'un relais : réparation ou rendement amélioré ;
- bonus plafonné pour éviter une croissance exponentielle.

Le risque est de rendre la doctrine trop passive ou de créer un effet boule de neige économique impossible à arrêter.

## Hypothèse C — Guerre/Légion

Cette doctrine doit résoudre les conflits par la force et la destruction d'infrastructures.

Bonus envisagés :

- attaquants infligeant environ 15 % de dégâts supplémentaires ;
- bonus de dégâts contre les bâtiments ;
- meilleure portée ou réactivité des ordres militaires ;
- éventuellement une unité ou capacité de siège ;
- aucun bonus général de capture ou de revenus.

Sa faiblesse naturelle serait le coût de maintien d'une armée qui ne produit rien lorsqu'elle ne combat pas.

## Orientation du joueur

Les bonus numériques ne suffisent pas. L'interface et les objectifs doivent enseigner le style associé.

### Pionnier

- mission initiale : atteindre un seuil de cases ;
- boutique mettant les robots en avant ;
- HUD affichant l'élan frontalier ;
- alertes sur les zones neutres, passages et ruptures de ravitaillement.

### Forge

- mission initiale : construire une usine et un relais ;
- boutique mettant les bâtiments en avant ;
- HUD affichant production, rendement et synergies de proximité ;
- alertes sur les bâtiments inactifs ou mal ravitaillés.

### Légion

- mission initiale : produire plusieurs attaquants ;
- HUD affichant la puissance militaire ;
- mise en évidence des cibles et bâtiments ennemis vulnérables ;
- objectif de destruction ou d'élimination.

Ces missions doivent guider sans obliger et ne doivent pas accorder un avantage décisif supplémentaire.

## Sélection avant la partie

L'écran de préparation pourrait présenter trois cartes :

```text
PIONNIER
Conquête rapide · Robots · Mobilité
Contrôlez la carte avant vos adversaires.

FORGE
Bâtiments · Production · Logistique
Transformez un petit territoire en puissance industrielle.

LÉGION
Armées · Assauts · Sièges
Détruisez les infrastructures ennemies.
```

Chaque carte montrerait :

- les bonus exacts ;
- la difficulté estimée ;
- l'unité ou le bâtiment emblématique ;
- l'objectif de départ ;
- une courte animation du style de jeu.

Le système ne devrait pas interdire l'accès aux autres unités. Une doctrine oriente et optimise un style, elle ne verrouille pas le joueur dans un rôle rigide.

## Évolution possible pendant la partie

Une seconde décision pourrait intervenir vers la cinquième minute :

- Pionnier : Nuée robotique ou Réseau de relais ;
- Forge : Production de masse ou Complexe fortifié ;
- Légion : Assaut rapide ou Siège lourd.

Cette spécialisation donnerait de l'adaptation, mais elle ne doit être ajoutée qu'après validation des trois doctrines principales.

## Relations et contres souhaités

Une piste de relation triangulaire serait :

- Pionnier gêne Forge en occupant l'espace et en coupant ses futures zones de développement ;
- Forge résiste à Légion par ses défenses, réparations et production continue ;
- Légion punit Pionnier en coupant ses longues lignes fragiles et en détruisant ses relais.

Ce modèle ne doit pas devenir un pierre-feuille-ciseaux automatique. Une meilleure exécution doit toujours permettre de gagner un affrontement défavorable.

## Contraintes de conception

- Pas de bonus permanent de puissance entre les parties.
- Pas de doctrine objectivement obligatoire.
- Pas de verrouillage complet des unités ou bâtiments.
- Pas de malus frustrant si le coût d'opportunité suffit.
- Pas de bonus économique multiplicatif non plafonné.
- Les valeurs doivent être compréhensibles dans l'interface.
- Les parties avec beaucoup d'IA doivent rester équilibrées.
- Le choix doit fonctionner au clavier, à la souris et sur mobile.
- La simulation doit rester autoritaire côté serveur.

## Contraintes techniques actuelles

Les valeurs générales sont centralisées dans `packages/game-config/src/index.ts`. Cependant, plusieurs calculs tournent dans le moteur Rust et sont actuellement globaux. Des bonus différents selon chaque joueur demanderont probablement :

1. un type partagé `Doctrine = "pioneer" | "forge" | "legion"` dans le protocole ;
2. le choix dans le message de connexion ou un message de préparation ;
3. le stockage de la doctrine dans l'état serveur du joueur ;
4. la transmission des multiplicateurs individuels au moteur Rust ;
5. l'application autoritaire des coûts, captures, dégâts et temps de production ;
6. l'affichage de la doctrine dans le HUD, le classement et l'écran final ;
7. des tests unitaires pour chaque bonus et leurs combinaisons.

Le client ne doit jamais être la source de vérité pour les bonus.

## Données nécessaires pour équilibrer

Pour chaque doctrine, il faudra mesurer au minimum :

- fréquence de sélection ;
- taux de victoire et placement moyen ;
- territoire maximal et courbe de territoire ;
- revenu total ;
- première unité et premier bâtiment produits ;
- nombre de captures, pertes et éliminations ;
- nombre d'unités et bâtiments produits ;
- durée de survie ;
- taux d'abandon ;
- résultats par proportion d'humains et d'IA.

Il faut également analyser les résultats par niveau de joueur. Une doctrine peut paraître équilibrée globalement tout en étant dominante chez les débutants ou les joueurs experts.

## Questions à résoudre

1. La séparation « jouer large » contre « jouer dense » est-elle suffisamment forte et intuitive ?
2. Faut-il modifier l'économie territoriale de base pour que Forge puisse fonctionner avec moins de cases ?
3. Comment produire un rendement industriel intéressant sans provoquer un effet boule de neige ?
4. L'Élan frontalier doit-il accorder de la mobilité, une remise ou une récompense économique ?
5. Les chaînes de bâtiments doivent-elles dépendre de la proximité, du ravitaillement ou des deux ?
6. Quelle faiblesse naturelle donner à chaque doctrine sans employer de malus artificiels ?
7. Comment garder les doctrines lisibles avec 50 entités logiques sur une très grande carte ?
8. Faut-il proposer le choix avant la partie, au début de la partie, ou après une courte phase neutre ?
9. Les spécialisations de mi-partie ajoutent-elles une vraie décision ou une complexité prématurée ?
10. Quelles valeurs de départ tester pour obtenir des puissances comparables sur 15 minutes ?

## Livrable attendu d'une prochaine analyse

À partir de ce brief, produire idéalement :

1. une critique des trois doctrines et de leurs boucles de jeu ;
2. une proposition de mécaniques finales, simples à expliquer ;
3. un tableau précis de bonus initiaux ;
4. une analyse des effets boule de neige et des contres ;
5. une proposition de sélection et de HUD ;
6. un plan d'implémentation progressif compatible avec l'architecture Node/Rust/Phaser ;
7. un protocole de test et d'équilibrage ;
8. les éléments qui devraient être supprimés ou reportés pour éviter la surconception.

