# open_scan_pokemon

Premier MVP web pour previsualiser une camera et choisir le capteur a utiliser avant de passer a la comprehension de carte Pokemon.

## Stack

- Vite + TypeScript
- UI mobile-first en HTML/CSS/TS natif
- Deploiement GitHub Pages via GitHub Actions

## Demarrage local

```bash
npm install
npm run dev
```

Le navigateur autorise la camera sur `localhost`. En production, GitHub Pages sert le site en HTTPS.

## Build

```bash
npm run build
```

Le projet publie les assets avec la base `/open_scan_pokemon/` pour GitHub Pages.

## Scope du MVP

- apercu camera live
- choix de la camera
- preference pour la camera arriere sur mobile
- memorisation du dernier capteur choisi
- lecture OCR du cadre courant avec Tesseract.js
- choix de la langue de carte pour piloter le modele OCR
- passe OCR dediee au numero de carte sur la bande basse
- lecture OCR par zones precises pour le nom, le HP/PV et la bande basse
- affichage du texte brut, des lignes detectees et des mots reconnus
- etats clairs pour permission, indisponibilite et erreur

Ce lot ne couvre pas encore la detection de carte, l identification fiable, le pricing ni le cadrage automatique.
