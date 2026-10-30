# WebApp Store Outils Épargne

Version web (statique, GitHub Pages) du **Store Outils Épargne** (`..\AppStore`, appli Electron) : la grille
d'icônes des outils de l'équipe, la fiche de chaque appli (description, captures, note « Message Update » de
la dernière version), le téléchargement par le dossier partagé SharePoint et l'installation en un clic par le
Store installé sur le poste.

## Sécurité

- Tout le catalogue est **chiffré** (AES-256-GCM, clé PBKDF2-SHA256, 310 000 itérations) : `docs/apps.enc.json`
  et `docs/media/*.json` (captures). Sans le jeton d'accès, la page ne montre que la demande de jeton.
- Le jeton et le sel sont dans `.private/jeton.json`, **jamais publié** (`.gitignore`). Lien d'accès à
  communiquer : `.private/lien-acces.txt` (`<adresse>#jeton=…` : le fragment n'est pas envoyé au serveur, la page
  l'efface de l'adresse et mémorise le jeton dans le navigateur).
- Changer de jeton (départ d'un collègue, fuite) : `generer.js --nouveau-jeton`, publier, communiquer le nouveau
  lien. Les anciens liens ne marchent plus.
- Le téléchargement reste contrôlé par SharePoint (connexion Microsoft) ; l'installation en un clic passe par le
  Store Electron (`outils-epargne-store://install/<id>`), qui demande confirmation.
- En clair dans le dépôt : le titre « Store Outils Épargne », le logo, le code de la page.

## Commandes (PowerShell, Node absent du PATH : l'Electron d'un projet voisin en mode Node)

```powershell
$env:ELECTRON_RUN_AS_NODE='1'; $e="..\AnalyseDynatrace\node_modules\electron\dist\electron.exe"
& $e tools\generer.js                       # régénère le catalogue chiffré depuis ..\_Packages
& $e tools\generer.js --adresse https://<compte>.github.io/<depot>/   # + écrit le lien d'accès
& $e tools\serveur.js                       # essai local : http://127.0.0.1:8765/
```

Sources lues par `generer.js` : `..\_Packages` (ZIP + notes ; macOS et sources écartés), `..\AppStore\lib\apps.js`
(catalogue), `..\AppStore\lib\share.js` (règles des noms de paquets), `..\AppStore\icons`, et les captures
`..\AppStore\screenshots\<id>\` (tenues par la session du Store Electron), sinon `captures\<id>\`
(« 1-Réduite - widget dans le dock.png » ; tri numérique, légende = nom sans le numéro).

À relancer après chaque publication d'un paquet dans `_Packages`, puis publier `docs/`.

## Publication

Dépôt public `https://github.com/arnaudbourdon/store-outils-epargne` ; page
`https://arnaudbourdon.github.io/store-outils-epargne/` (Settings > Pages : branche `main`, dossier `/docs`).
Git n'est pas installé sur le poste : le dossier `_a_publier\` (tout sauf `.private\`, vérifié sans le jeton)
se dépose par la page du dépôt, « Add file > Upload files ». Pour une mise à jour, ne redéposer que
`docs\` (supprimer d'abord sur GitHub les `docs/media/*.json` qui ne sont plus dans `_a_publier\docs\media`).
