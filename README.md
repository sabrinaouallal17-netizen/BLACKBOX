# BLACKBOX

Une application pour gérer et planifier nos jeux en équipe : tâches, bugs, releases, collections d'assets, activité et chat, avec de vrais comptes (email ou compte Google). Elle s'installe comme une application sur ordinateur et téléphone.

## Fonctionnalités

- **Comptes** : connexion avec un compte Google, ou inscription par email et mot de passe avec confirmation de l'email, mot de passe oublié, changement d'email (confirmé par lien) et de mot de passe
- **Profil** : photo, nom, rôle, email de contact, visibles par l'équipe
- **Projets** : icône et miniature du jeu, description, plateformes avec icônes (Roblox, PC, Mac, mobile, consoles…), tags
- **Équipe** : invitation par email, acceptation ou refus, retrait de membres par le propriétaire
- **Tâches et bugs** : menu ⋯ (Edit / Up / Down / Delete), filtres par statut et par membre
- **Chat façon Discord** : **gras**, *italique*, ~~barré~~, `code`, citations, plusieurs images par message (glisser-déposer, coller ou trombone), bibliothèque de GIF, modifier ou supprimer ses messages
- **Assets** : images, miniatures, icônes et GIF de l'équipe, filtres, aperçu, « utiliser comme icône ou miniature »
- **Collections** : éléments avec image, vue grille (image et infos sur la carte) ou liste ; déposer plusieurs images crée un élément par image
- **Activity** : journal complet de toutes les modifications, avec une icône par type, filtres par type et par membre, et le détail des changements (Statut : To do → Done)
- **Rôles** : Owner, Admin, Member, Viewer (lecture et chat), appliqués dans l'interface et dans les règles Firebase
- **Salons de chat** comme Discord, avec point « non lu » ; **@mentions** et **notifications** (mentions, tâches assignées, patch notes publiées, changement de rôle)
- **Kanban** : vue Board pour les tâches et les bugs, cartes à glisser d'une colonne à l'autre (souris ou doigt)
- **Updates** : patch notes du jeu (Nouveautés, Améliorations, Corrections, Équilibrage), pré-remplies avec les tâches terminées et les bugs corrigés
- **Dossiers d'assets** et **téléchargement** des images (chat, aperçu, assets)
- **Fluidité** : la page se met à jour sur place (bibliothèque [Idiomorph](https://github.com/bigskysoftware/idiomorph)), sans clignotement ; les messages apparaissent tout de suite pendant l'envoi
- **What's new** : l'historique des versions de BLACKBOX, dans le panneau de notifications et le profil
- **Application installable** : bouton **Install app** dans la barre latérale (Chrome, Edge, Android) ou **Partager → Sur l'écran d'accueil** sur iPhone ; fonctionne hors ligne une fois chargée
- **Mobile** : barre du haut, onglets en bas, cartes de tâches, fenêtres en bas d'écran
- **Sauvegarde** : tout est enregistré en ligne et partagé en temps réel ; l'indicateur en bas de la barre latérale affiche « All changes saved », « Saving… » ou « Offline ». Un texte en cours de saisie n'est pas effacé quand un coéquipier modifie quelque chose.

Dans la version GitHub (Firebase), les images sont compressées et stockées dans la base (GIF jusqu'à 600 Ko), sans Firebase Storage, qui demande un abonnement payant. La version Artifact accepte des fichiers jusqu'à 20 Mo.

## Mise en route (une seule fois, environ 5 minutes)

BLACKBOX stocke les comptes et les données dans [Firebase](https://firebase.google.com), gratuit pour un petit projet.

1. Va sur la [console Firebase](https://console.firebase.google.com) et clique **Add project** (Créer un projet). Google Analytics n'est pas nécessaire.
2. **Build → Authentication → Get started**, puis dans l'onglet **Sign-in method**, active **Email/Password**, puis **Google** (choisis un email d'assistance et clique **Save**).
3. **Build → Firestore Database → Create database**. Choisis une région proche (par exemple `europe-west`) et le mode **production**.
4. Toujours dans Firestore, onglet **Rules** : remplace tout le contenu par celui du fichier [`firestore.rules`](firestore.rules), puis clique **Publish**.
5. **Project settings** (roue dentée) → **General** → **Your apps** → icône **Web** `</>`. Donne un nom (par exemple `blackbox`), sans Firebase Hosting. Firebase affiche un bloc `firebaseConfig`.
6. Copie ces valeurs dans [`firebase-config.js`](firebase-config.js), à la place de `null` (un exemple y est donné).
7. **Authentication → Settings → Authorized domains** → **Add domain** : `sabrinaouallal17-netizen.github.io`.

Les valeurs de `firebase-config.js` sont publiques par conception : ce sont les règles de `firestore.rules` qui protègent les données (seuls les membres d'un projet y ont accès).

## Mettre en ligne

GitHub → **Settings → Pages** → Source **Deploy from a branch**, branche `main`, dossier `/ (root)`. L'app est alors disponible sur `https://sabrinaouallal17-netizen.github.io/BLACKBOX/`.

## Version Artifact (claude.ai)

Une deuxième édition tourne comme page Artifact sur claude.ai, sans Firebase : les comptes sont des comptes Claude et les données sont dans la base de la page. Le même `app.js` est utilisé ; `artifact/backend.js` remplace le SDK Firebase.

- Construire la page : `python3 artifact/build.py blackbox.html`, puis la publier comme Artifact avec les capacités `db` (règle : chacun modifie son propre profil), `user` (portée `profile`), `assets` (fichiers) et `downloads` (téléchargements). Dans cette version, les rôles sont appliqués par l'interface seulement.
- Inviter quelqu'un : menu **Share** de la page → invitation par email comme **Editor**. La personne ouvre le lien et clique **Join** sur le projet.
- Toutes les personnes qui ont accès à la page voient tous les projets ; les accès en lecture seule ne peuvent rien modifier.
- Test : `tests/artifact-e2e.js` avec la fausse plateforme `tests/mock-claude.js`.

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
- `app.js` : pages, actions et données (Firebase ou Artifact)
- `ui.js` : menus, listes déroulantes, fenêtres, aperçu d'images, mise en forme du chat, images
- `icons.js` : icônes de l'interface et des plateformes
- `notify.js` : notifications et mentions ; `board.js` : Kanban ; `updates.js` : patch notes
- `changelog.js` : What's new de BLACKBOX (à compléter à chaque changement) ; `boot.js` : démarrage
- `firebase-config.js` : configuration du projet Firebase
- `firestore.rules` : règles de sécurité de la base
- `firebase.json` : configuration des émulateurs
- `manifest.webmanifest`, `sw.js`, `icons/` : application installable (PWA)
- `artifact/` : édition Artifact (`backend.js`, `build.py`)
