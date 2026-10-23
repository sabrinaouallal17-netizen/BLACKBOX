# BLACKBOX

Une application pour gérer et planifier nos jeux en équipe : tâches, bugs, releases, collections d'assets, activité et chat, avec de vrais comptes (connexion par email).

## Fonctionnalités

- **Comptes** : inscription et connexion par email et mot de passe, confirmation de l'email obligatoire, mot de passe oublié
- **Projets** : plusieurs projets ; nom, description, plateformes et tags modifiables ; suppression (propriétaire) ou départ (membre)
- **Équipe** : invitation par email ; la personne voit l'invitation à sa connexion et l'accepte ou la refuse ; le propriétaire peut retirer des membres
- **Tâches et bugs** : création, modification, suppression, filtres par statut et par membre ; menu ⋯ avec Edit / Up / Down / Delete pour réordonner
- **Release** : checklist avec progression
- **Collections** : listes d'assets (personnages, maps, icônes…)
- **Activity** et **Chat** séparés, mis à jour en temps réel pour toute l'équipe

## Mise en route (une seule fois, environ 5 minutes)

BLACKBOX stocke les comptes et les données dans [Firebase](https://firebase.google.com), gratuit pour un petit projet.

1. Va sur la [console Firebase](https://console.firebase.google.com) et clique **Add project** (Créer un projet). Google Analytics n'est pas nécessaire.
2. **Build → Authentication → Get started**, puis dans l'onglet **Sign-in method**, active **Email/Password**.
3. **Build → Firestore Database → Create database**. Choisis une région proche (par exemple `europe-west`) et le mode **production**.
4. Toujours dans Firestore, onglet **Rules** : remplace tout le contenu par celui du fichier [`firestore.rules`](firestore.rules), puis clique **Publish**.
5. **Project settings** (roue dentée) → **General** → **Your apps** → icône **Web** `</>`. Donne un nom (par exemple `blackbox`), sans Firebase Hosting. Firebase affiche un bloc `firebaseConfig`.
6. Copie ces valeurs dans [`firebase-config.js`](firebase-config.js), à la place de `null` (un exemple y est donné).
7. **Authentication → Settings → Authorized domains** → **Add domain** : `sabrinaouallal17-netizen.github.io`.

Les valeurs de `firebase-config.js` sont publiques par conception : ce sont les règles de `firestore.rules` qui protègent les données (seuls les membres d'un projet y ont accès).

## Mettre en ligne

GitHub → **Settings → Pages** → Source **Deploy from a branch**, branche `main`, dossier `/ (root)`. L'app est alors disponible sur `https://sabrinaouallal17-netizen.github.io/BLACKBOX/`.

## Développement local

Sans build ni dépendance pour l'app elle-même :

```sh
python3 -m http.server 5173
# puis http://localhost:5173
```

Pour travailler sans toucher au vrai projet Firebase, lance les émulateurs (nécessite Java et `firebase-tools`) et ouvre l'app avec `?emulator` :

```sh
npx firebase-tools emulators:start --project demo-blackbox --only auth,firestore
# puis http://localhost:5173/index.html?emulator
```

Les emails de confirmation n'existent pas dans l'émulateur ; leurs liens sont listés sur `http://127.0.0.1:9099/emulator/v1/projects/demo-blackbox/oobCodes`.

### Tests de bout en bout

`tests/e2e.js` joue un scénario complet sur les émulateurs avec Playwright : inscription, confirmation, projets, tâches (menu ⋯), invitations, chat en temps réel entre deux comptes, règles de sécurité (membre et inconnu), suppression du projet, affichage mobile.

```sh
PW=<chemin vers playwright> SDK=<chemin vers node_modules/firebase> OUT=/tmp node tests/e2e.js
```

## Fichiers

- `index.html` : écrans (connexion, app, fenêtres)
- `styles.css` : thème et mise en page responsive
- `app.js` : rendu, navigation, Firebase (auth, données en temps réel)
- `firebase-config.js` : configuration du projet Firebase
- `firestore.rules` : règles de sécurité de la base
- `firebase.json` : configuration des émulateurs
