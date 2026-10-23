# BLACKBOX

Une application pour gérer et planifier nos jeux : tâches, bugs, releases, collections d'assets et chat d'équipe, le tout dans un dashboard sombre.

## Lancer

Pas de build, pas de dépendances. Ouvre `index.html` dans un navigateur, ou :

```sh
python3 -m http.server 8000
# puis http://localhost:8000
```

Les données sont enregistrées dans le `localStorage` du navigateur. L'icône ⚙ en bas de la barre latérale remet le projet de démo.

## Fonctionnalités

- **Overview** : stats (à faire, en cours, bugs ouverts, terminées), tâches prioritaires, prochaine release, activité récente, collections
- **Tasks / Bugs** : liste filtrable par statut et par membre ; création, édition et suppression
- **Activity & Chat** : historique des actions et chat d'équipe
- **Collections** : dossiers d'assets (personnages, maps, UI…)
- Plusieurs projets, ajout de membres, checklist de release

## Fichiers

- `index.html` : structure et formulaire de tâche
- `styles.css` : thème et mise en page responsive
- `data.js` : données de démo (Baddie Dice)
- `app.js` : rendu, navigation et persistance
