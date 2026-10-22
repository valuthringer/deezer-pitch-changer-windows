# Deezer Pitch Changer

Ajoute un réglage de **vitesse** et de **hauteur** (pitch) à l'application **Deezer Desktop pour Windows**.

Trois modes :

| Mode | Effet | Moteur |
|---|---|---|
| **Vitesse + hauteur** | Comme un vinyle accéléré / ralenti (nightcore, slowed…) | `playbackRate` natif, sans correction de hauteur |
| **Vitesse** | Plus rapide ou plus lent, même tonalité | `playbackRate` natif + `preservesPitch` (étirement temporel de Chromium) |
| **Hauteur** | Change la tonalité, même tempo (−12 à +12 demi-tons, 432 Hz…) | AudioWorklet de pitch-shift (vocodeur de phase) |

## Installation

Prérequis : [Node.js](https://nodejs.org) 18 ou plus récent. Le projet n'a aucune dépendance npm.

1. Double-clique sur **`Installer.cmd`**.
2. Si Deezer est ouvert, le programme propose de le fermer, puis le relance une fois le patch appliqué.

Dans Deezer, le bouton **Pitch** apparaît en bas à droite (tu peux le déplacer en le faisant glisser) :

- **clic** ou **Alt+P** : ouvre ou ferme le panneau ;
- **Alt+Shift+P** : active ou désactive l'effet ;
- **molette sur le curseur** : réglage fin ; **double-clic** : retour à la valeur neutre.

Les réglages sont mémorisés entre deux sessions.

> **Après une mise à jour de Deezer**, le patch disparaît (la mise à jour remplace `app.asar`). Il suffit de relancer `Installer.cmd`.

## Désinstallation

Double-clique sur **`Desinstaller.cmd`** : le fichier `app.asar` d'origine est restauré.

## Ligne de commande

```
node src/cli.js install     [--path <dossier Deezer>] [--yes] [--no-launch]
node src/cli.js uninstall   [--path <dossier Deezer>] [--yes] [--no-launch]
node src/cli.js status
```

Le dossier est détecté automatiquement (`%LOCALAPPDATA%\Programs\deezer-desktop` par défaut).

## Fonctionnement

L'application Deezer est une coquille Electron qui affiche le lecteur web de `deezer.com`.

- **`src/patcher.js`** ajoute un bloc à `build/preload.js` dans `resources/app.asar`. C'est le seul fichier modifié, et une sauvegarde `app.asar.pitch-changer-backup` est créée.
- **`src/asar.js`** réécrit l'archive en remplaçant uniquement ce fichier. Les autres fichiers gardent leurs octets et leurs offsets.
- **Le bloc ajouté au preload** exécute **`src/inject/pitch-changer.js`** dans la page via `webFrame.executeJavaScript`. Ce script :
  - repère l'élément `<audio>` du lecteur ;
  - règle `playbackRate` et `preservesPitch` ;
  - en mode Hauteur, fait passer l'audio par **`src/inject/pitch-worklet.js`** ;
  - affiche le panneau (dans un Shadow DOM, pour ne pas toucher au style de Deezer).
- **Le pitch-shifter** est un vocodeur de phase avec verrouillage de phase autour des pics (Laroche & Dolson). La rotation de phase est commune aux deux canaux pour préserver l'image stéréo. Latence : environ 85 ms. CPU : environ 3 % d'un cœur.

## Limites

- Le mode **Hauteur** a la qualité typique d'un vocodeur de phase : très bonne sur de faibles écarts (±3 demi-tons), plus « métallique » au-delà, avec des attaques de batterie un peu adoucies.
- Si Deezer change la structure de son application, il faudra peut-être adapter le patch.
- Modifier le client Deezer n'est pas prévu par ses conditions d'utilisation : usage personnel, à tes risques.

## Développement

```
npm test                       # tests du pitch-shifter et du patch asar
set DZ_DEVTOOLS=yes && "%LOCALAPPDATA%\Programs\deezer-desktop\Deezer.exe"   # Deezer avec les DevTools
```

Dans la console des DevTools, `window.__deezerPitchChanger` donne accès à l'état (réglages, éléments audio suivis, moteur).
