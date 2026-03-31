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
- etats clairs pour permission, indisponibilite et erreur

Ce lot ne couvre pas encore la detection de carte, l OCR, la capture d image ni le pricing.
