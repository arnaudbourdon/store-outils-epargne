'use strict';

// LE GÉNÉRATEUR DU CATALOGUE CHIFFRÉ de la WebApp Store. Il lit, sur le poste d'Arnaud :
//   - le dossier « _Packages » (copie OneDrive locale) : ZIP + notes « …Message Update.txt » ;
//   - le catalogue du Store Electron (..\AppStore\lib\apps.js : noms, descriptions, installation
//     silencieuse) et ses icônes (..\AppStore\icons) ; les règles de lecture des noms de paquets sont
//     celles de ..\AppStore\lib\share.js (chargé tel quel, sans son navigateur) ;
//   - les captures d'écran : ..\AppStore\screenshots\<id>\ (celles du Store Electron), sinon captures\<id>\
//     (png, jpg ; tri numérique ; légende = nom sans le numéro de tête : « 1-Réduite - widget dans le dock.png »
//     → « Réduite - widget dans le dock »).
// Il écrit docs\apps.enc.json et docs\media\*.json, chiffrés (AES-256-GCM, clé PBKDF2-SHA256 du jeton).
// Le jeton et le sel vivent dans .private\ (jamais publié). Rien n'est écrit ailleurs que dans ce projet.
//
//   $env:ELECTRON_RUN_AS_NODE='1'; & <electron.exe> tools\generer.js [--nouveau-jeton] [--adresse <url de la page>]

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const OUTILS = path.resolve(ROOT, '..');
const STORE = path.join(OUTILS, 'AppStore');
const PACKAGES = path.join(OUTILS, '_Packages');
const PRIVATE = path.join(ROOT, '.private');
const DOCS = path.join(ROOT, 'docs');
const MEDIA = path.join(DOCS, 'media');
const ITER = 310000;
const STORE_ID = 'AppStore';
const SHOT_DIRS = [path.join(STORE, 'screenshots'), path.join(ROOT, 'captures')];
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

// share.js du Store, sans son navigateur (Playwright) ni son journal : seules ses règles servent ici.
for (const [file, exports] of [['browser.js', {}], ['log.js', { log() {} }]]) {
  const p = path.join(STORE, 'lib', file);
  require.cache[p] = Object.assign(new Module(p), { filename: p, loaded: true, exports });
}
const share = require(path.join(STORE, 'lib', 'share.js'));
const { APPS } = require(path.join(STORE, 'lib', 'apps.js'));

// LE JETON : 20 caractères sans ambiguïté (pas de 0/O, 1/I), ~100 bits, en groupes de 4.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const norm = (t) => String(t ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function secret() {
  fs.mkdirSync(PRIVATE, { recursive: true });
  const file = path.join(PRIVATE, 'jeton.json');
  let s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (!s || args.includes('--nouveau-jeton')) {
    const replaced = Boolean(s);
    const token = Array.from({ length: 20 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('').match(/.{4}/g).join('-');
    s = { token, salt: crypto.randomBytes(16).toString('base64'), createdAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(s, null, 2));
    console.log(replaced ? 'Nouveau jeton créé : les anciens liens d’accès ne marchent plus.' : 'Jeton créé.');
  }
  return s;
}

const seal = (key, plain, iv = crypto.randomBytes(12)) => {
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), data: data.toString('base64') };
};

// Les notes sont en UTF-8 (avec ou sans BOM) ; sinon Windows-1252 (même règle que share.text).
function noteText(file) {
  const buf = fs.readFileSync(file);
  const s = buf.toString('utf8');
  return (s.includes('�') ? new TextDecoder('windows-1252').decode(buf) : s).replace(/^﻿/, '').trim();
}
// Paquet inconnu du catalogue : le début de sa note sert de description (même règle que describeUnknown,
// AppStore\app\main.js : titres, « Objet : », « Bonjour » et soulignements écartés).
function describeUnknown(note) {
  const useful = note.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[=\-_*#]{3,}$/.test(l) && !/^(objet|subject)\s*:/i.test(l) && !/^bonjour/i.test(l) && !/nouveaut|version\s+\d/i.test(l));
  const all = useful.join(' ');
  return all.slice(0, 320).replace(/\s+\S*$/, '') + (all.length > 320 ? '…' : '');
}
// LE LIEN DE TÉLÉCHARGEMENT d'un ZIP du dossier partagé : download.aspx de SharePoint, tiré du lien de
// partage du dossier (…/:f:/r/personal/<compte>/<chemin>?…). L'accès reste contrôlé par SharePoint (SSO).
function downloadUrl(file) {
  const u = new URL(share.DEFAULT_SHARE_URL);
  const folder = decodeURIComponent(u.pathname.replace(/^\/:[a-z]:\/r/, ''));
  const site = folder.split('/').slice(0, 3).join('/'); // /personal/<compte>
  return `${u.origin}${site}/_layouts/15/download.aspx?SourceUrl=${encodeURIComponent(`${folder}/${file}`)}`;
}
// Le nom affichable de l'installeur, quand l'expression du catalogue est un nom exact
// (/^Installer Store Outils Epargne\.vbs$/i → « Installer Store Outils Epargne.vbs ») ; sinon null.
function installerName(re) {
  const src = re instanceof RegExp ? re.source.replace(/^\^/, '').replace(/\$$/, '') : null;
  return src && !/[*+?()[\]{}|]|(^|[^\\])\./.test(src) ? src.replace(/\\(.)/g, '$1') : null;
}
function dataUri(file) {
  return fs.existsSync(file) ? `data:${MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'};base64,${fs.readFileSync(file).toString('base64')}` : null;
}
function shotsOf(id) {
  for (const dir of SHOT_DIRS.map((d) => path.join(d, id))) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
    if (files.length) return files.map((f) => ({ path: path.join(dir, f), caption: f.replace(/\.[^.]+$/, '').replace(/^\d+\s*[-_.]\s*/, ''), type: MIME[path.extname(f).toLowerCase()] }));
  }
  return [];
}

function main() {
  const s = secret();
  const key = crypto.pbkdf2Sync(norm(s.token), Buffer.from(s.salt, 'base64'), ITER, 32, 'sha256');
  const files = fs.readdirSync(PACKAGES).map((name) => {
    const st = fs.statSync(path.join(PACKAGES, name));
    return st.isFile() ? { name, size: st.size, at: st.mtimeMs, url: path.join(PACKAGES, name) } : null;
  }).filter(Boolean);
  const published = share.packages(files, APPS);

  fs.mkdirSync(MEDIA, { recursive: true });
  const written = new Set();
  const shotsFor = (id) => shotsOf(id).map((sh) => {
    const plain = fs.readFileSync(sh.path);
    // Nom et IV tirés du contenu (HMAC) : une capture inchangée garde le même fichier d'une génération à l'autre.
    const mac = crypto.createHmac('sha256', key).update(plain).digest();
    const file = `${mac.subarray(0, 12).toString('hex')}.json`;
    fs.writeFileSync(path.join(MEDIA, file), JSON.stringify(seal(key, plain, mac.subarray(12, 24))));
    written.add(file);
    return { file, caption: sh.caption, type: sh.type };
  });
  const iconOf = (a) => (a.icon ? dataUri(path.join(STORE, 'icons', a.icon)) : null);
  const packaged = [...published.values()].map((p) => {
    const a = APPS.find((x) => x.id === p.id) ?? {};
    const note = p.note ? noteText(p.note.url) : null;
    return {
      id: p.id,
      name: a.name ?? p.id,
      description: a.description ?? (note ? describeUnknown(note) : null),
      icon: iconOf(a),
      version: p.version,
      size: p.zip.size,
      at: p.zip.at,
      file: p.zip.name,
      download: downloadUrl(p.zip.name),
      note,
      install: Boolean(a.silent && a.installer) && p.id !== STORE_ID, // le Store ne s'installe pas par lui-même
      installer: installerName(a.installer),
      shots: shotsFor(p.id)
    };
  });
  // Les applis web du catalogue (pkg null, `web` = leur adresse) : pas de paquet, un bouton « Ouvrir ».
  const web = APPS.filter((a) => a.web && /^https:\/\//i.test(a.web)).map((a) => ({
    id: a.id, name: a.name ?? a.id, description: a.description ?? null, icon: iconOf(a), web: a.web, install: false, shots: shotsFor(a.id)
  }));
  const apps = [...packaged, ...web].sort((x, y) => x.name.localeCompare(y.name, 'fr'));
  for (const f of fs.readdirSync(MEDIA)) if (!written.has(f)) fs.rmSync(path.join(MEDIA, f));

  const payload = { generatedAt: new Date().toISOString(), shareUrl: share.DEFAULT_SHARE_URL, storeId: STORE_ID, apps };
  const box = { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: s.salt, ...seal(key, Buffer.from(JSON.stringify(payload))) };
  fs.writeFileSync(path.join(DOCS, 'apps.enc.json'), JSON.stringify(box));
  fs.writeFileSync(path.join(PRIVATE, 'apps.json'), JSON.stringify({ ...payload, apps: apps.map((x) => ({ ...x, icon: x.icon ? `${x.icon.slice(0, 30)}…` : null })) }, null, 2));

  const adresse = opt('--adresse');
  if (adresse) fs.writeFileSync(path.join(PRIVATE, 'adresse.txt'), adresse.trim());
  const base = fs.existsSync(path.join(PRIVATE, 'adresse.txt')) ? fs.readFileSync(path.join(PRIVATE, 'adresse.txt'), 'utf8').trim() : null;
  if (base) fs.writeFileSync(path.join(PRIVATE, 'lien-acces.txt'), `${base.replace(/#.*$/, '')}#jeton=${s.token}\r\n`);

  console.log(`${apps.length} applis : ${apps.map((x) => `${x.id} ${x.web ? '(web)' : x.version ?? '(sans version)'}${x.note || x.web ? '' : ' [sans note]'}${x.shots.length ? ` [${x.shots.length} captures]` : ''}`).join(', ')}`);
  console.log(`Écarté : ${files.filter((f) => /\.zip$/i.test(f.name) && !share.packageOf(f.name, APPS)).map((f) => f.name).join(', ') || 'rien'}`);
  console.log(`docs\\apps.enc.json : ${Math.round(fs.statSync(path.join(DOCS, 'apps.enc.json')).size / 1024)} Ko ; ${written.size} capture(s) dans docs\\media`);
  console.log(`Jeton : .private\\jeton.json${base ? ' ; lien d’accès : .private\\lien-acces.txt' : ' (lien d’accès : relancer avec --adresse <url de la page>)'}`);
}

main();
