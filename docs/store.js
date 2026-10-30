'use strict';

// LA WEBAPP STORE : la grille d'icônes du Store Outils Épargne, en page web statique (GitHub Pages).
// Tout le catalogue (noms, descriptions, icônes, notes de version, captures, lien SharePoint) est
// CHIFFRÉ (AES-256-GCM, clé PBKDF2-SHA256 du jeton d'accès) : sans le jeton, la page n'affiche que
// la demande de jeton. Le jeton arrive par le lien d'accès (`#jeton=…`, jamais envoyé au serveur) ou
// par saisie, puis reste dans ce navigateur. Les captures sont chiffrées une par fichier (`media/`)
// et déchiffrées à l'ouverture de la fiche.
// « Installer » appelle le Store Electron du poste (`outils-epargne-store://install/<id>`) ; le
// téléchargement passe par le dossier partagé SharePoint (accès contrôlé par SharePoint / SSO).

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STORAGE = 'webappstore.jeton';
const PROTOCOL = 'outils-epargne-store://install/';
const remembered = {
  get() { try { return localStorage.getItem(STORAGE); } catch { return null; } },
  set(v) { try { if (v) localStorage.setItem(STORAGE, v); else localStorage.removeItem(STORAGE); } catch { /* navigation privée */ } }
};
let data = null;
let key = null;
let filter = '';

const sizeTxt = (n) => (n ? (n >= 1073741824 ? `${(n / 1073741824).toFixed(1).replace('.', ',')} Go` : `${Math.max(1, Math.round(n / 1048576))} Mo`) : '');
const dateTxt = (t) => (t ? new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '');
const initials = (name) => name.split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

// LE DÉCHIFFREMENT
const norm = (t) => String(t ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`fichier introuvable (${res.status})`);
  return res.json();
}
async function unlock(token) {
  const box = await fetchJson('apps.enc.json');
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(norm(token)), 'PBKDF2', false, ['deriveKey']);
  const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: bytes(box.salt), iterations: box.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(box.iv) }, k, bytes(box.data));
  } catch {
    throw Object.assign(new Error('Jeton incorrect (ou remplacé depuis).'), { bad: true });
  }
  key = k;
  return JSON.parse(new TextDecoder().decode(plain));
}
const shots = new Map(); // fichier → adresse blob: déchiffrée
async function shot(s) {
  if (!shots.has(s.file)) {
    const box = await fetchJson(`media/${s.file}`);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(box.iv) }, key, bytes(box.data));
    shots.set(s.file, URL.createObjectURL(new Blob([plain], { type: s.type })));
  }
  return shots.get(s.file);
}

// L'AFFICHAGE
function icon(a, cls = 'icon') {
  return /^data:image\//.test(a.icon ?? '') ? `<img class="${cls}" src="${esc(a.icon)}" alt="" data-detail="${esc(a.id)}">` : `<div class="${cls} letters" data-detail="${esc(a.id)}">${esc(initials(a.name))}</div>`;
}
// L'ÉTAT DU POSTE : le Store Electron, s'il tourne, répond sur ce poste seulement à LOCAL (installée,
// version, lancée). Une page web ne voit rien d'autre du poste : sans réponse, l'état reste inconnu.
const LOCAL = 'http://127.0.0.1:47615/etat';
let local = null; // { store: { version }, apps: Map id → { installed, installedVersion, running } } ; null = Store muet
async function readLocal() {
  let next = null;
  try {
    const res = await fetch(LOCAL, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const s = await res.json();
      next = { store: s.store ?? {}, apps: new Map((s.apps ?? []).map((x) => [x.id, x])) };
    }
  } catch { /* Store absent, fermé, ou accès au réseau local refusé */ }
  const changed = JSON.stringify(next && [next.store, [...next.apps]]) !== JSON.stringify(local && [local.store, [...local.apps]]);
  local = next;
  if (changed && data) render();
}

/** -1, 0, 1 : comparaison de deux versions « a.b.c » (même règle que AppStore\lib\share.js). */
function compare(a, b) {
  const x = String(a ?? '').split('.').map(Number), y = String(b ?? '').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}
// L'état d'une appli sur ce poste (null = inconnu, le Store ne répond pas). Le Store lui-même est
// installé dès qu'il répond ; une appli web est toujours « installée » (règle du Store Electron).
function stateOf(a) {
  if (!local) return null;
  if (a.web) return { installed: true, web: true };
  const l = a.id === data.storeId ? { installed: true, installedVersion: local.store.version } : local.apps.get(a.id);
  if (!l?.installed) return { installed: false };
  return { ...l, update: Boolean(l.installedVersion && a.version && compare(a.version, l.installedVersion) > 0) };
}

function buttons(a) {
  if (a.web) return `<button class="pill primary" data-web="${esc(a.id)}" title="${esc(a.web)}">Ouvrir</button>`;
  const st = stateOf(a);
  const download = `<button class="pill" data-download="${esc(a.id)}" title="Ouvre le dossier partagé SharePoint (connexion Microsoft)">Télécharger</button>`;
  if (st?.installed && !st.update) return '';
  if (st?.update) return a.install && a.id !== data.storeId ? `<button class="pill primary" data-install="${esc(a.id)}" title="Installation silencieuse de la ${esc(a.version)} par le Store du poste">Mettre à jour</button>` : download;
  return (a.install ? `<button class="pill primary" data-install="${esc(a.id)}" title="Installation silencieuse par le Store Outils Épargne du poste">Installer</button>` : '') + download;
}
function stateLine(a) {
  const st = stateOf(a);
  if (!st || st.web) return '';
  if (st.update) return `<div class="state update">Mise à jour : ${esc(st.installedVersion)} → ${esc(a.version)}</div>`;
  if (st.running) return `<div class="state running">● Lancée${st.installedVersion ? ` · ${esc(st.installedVersion)}` : ''}</div>`;
  if (st.installed) return `<div class="state installed">✓ Installée${st.installedVersion ? ` · ${esc(st.installedVersion)}` : ''}</div>`;
  return '';
}
function card(a) {
  const meta = a.web ? 'Application web' : [a.version ? `v${a.version}` : '', sizeTxt(a.size), dateTxt(a.at)].filter(Boolean).join(' · ');
  return `<div class="app">
    ${icon(a)}
    <div class="name" data-detail="${esc(a.id)}">${esc(a.name)}</div>
    <div class="meta">${esc(meta)}</div>
    ${stateLine(a)}
    <div class="desc">${esc(a.description ?? '')}</div>
    <div class="btns">${buttons(a)}</div>
  </div>`;
}
const section = (title, list) => (list.length ? `<h2>${title}<small>${list.length} appli${list.length > 1 ? 's' : ''}</small></h2><div class="grid">${list.map(card).join('')}</div>` : '');
function render() {
  const q = filter.trim().toLowerCase();
  const list = data.apps.filter((a) => !q || `${a.name} ${a.description ?? ''} ${a.id}`.toLowerCase().includes(q));
  $('sub').textContent = `${data.apps.length} applis · catalogue du ${new Date(data.generatedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`;
  const hint = local
    ? ''
    : `<div class="hint">Le Store Outils Épargne ne répond pas : la page ne peut pas savoir ce qui est installé sur ce poste. Lancez-le (menu Démarrer), ou installez-le si c’est votre première fois. <button class="pill" data-first>Première fois ?</button></div>`;
  const grids = !list.length
    ? `<div class="empty">${q ? 'Aucune appli ne correspond.' : 'Aucune appli publiée.'}</div>`
    : local
      ? section('À découvrir', list.filter((a) => !stateOf(a).installed)) + section('Installées sur ce poste', list.filter((a) => stateOf(a).installed))
      : section('Les outils de l’équipe', list);
  $('main').innerHTML = hint + grids;
}

function sheet(html) {
  const box = $('detail');
  box.innerHTML = `<div class="sheet">${html}</div>`;
  box.hidden = false;
  return box;
}
async function showDetail(id) {
  const a = data.apps.find((x) => x.id === id);
  if (!a) return;
  const meta = a.web ? 'Application web' : [a.version ? `Version ${a.version}` : '', sizeTxt(a.size), a.at ? `publiée le ${new Date(a.at).toLocaleDateString('fr-FR')}` : ''].filter(Boolean).join(' · ');
  const box = sheet(`<div class="top">${icon(a)}<div><h3>${esc(a.name)}</h3><div class="meta">${esc(meta)}</div>${stateLine(a)}<div class="meta">${esc(a.description ?? '')}</div></div><button class="ghost close" data-close title="Fermer">✕</button></div>
    <div class="actions">${buttons(a)}<span class="file">${esc(a.web ?? a.file)}</span></div>
    <div class="scroll">
      ${a.shots?.length ? `<div class="shots">${a.shots.map((s, i) => `<figure><div class="shot" data-shot="${i}">Déchiffrement…</div><figcaption>${esc(s.caption)}</figcaption></figure>`).join('')}</div>` : ''}
      ${a.web ? '' : `<h4>Nouveautés de la version ${esc(a.version ?? '')}</h4>
      <div class="note">${a.note ? esc(a.note) : 'Pas de note de version publiée.'}</div>`}
    </div>`);
  (a.shots ?? []).forEach(async (s, i) => {
    const slot = box.querySelector(`[data-shot="${i}"]`);
    try {
      const url = await shot(s);
      if (slot?.isConnected) slot.outerHTML = `<img class="shot" src="${esc(url)}" alt="${esc(s.caption)}" data-zoom="${esc(url)}">`;
    } catch (e) {
      if (slot) slot.textContent = `Capture illisible (${e.message})`;
    }
  });
}

let toastTimer = null;
function toast(text, ms = 5000) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, ms);
}

// Le dossier partagé : seul lien sortant de la page, vérifié (SharePoint de MH).
function openShare(a) {
  const url = data.shareUrl;
  if (!/^https:\/\/[a-z0-9-]+(-my)?\.sharepoint\.com\//i.test(url ?? '')) return toast('Lien du dossier partagé invalide dans le catalogue.');
  window.open(url, '_blank', 'noopener');
  if (a) toast(`Dans le dossier partagé, téléchargez « ${a.file} », puis lancez l’installeur qu’il contient.`, 9000);
}

// Une appli web du catalogue : son adresse (https seulement), dans un nouvel onglet.
function openWeb(a) {
  if (!/^https:\/\//i.test(a?.web ?? '')) return toast('Adresse de l’appli web invalide dans le catalogue.');
  window.open(a.web, '_blank', 'noopener');
}

// L'installation : le Store Electron du poste répond au lien `outils-epargne-store://` et demande
// confirmation. S'il répond déjà à LOCAL, il est là : on suit l'état jusqu'à la fin de l'installation.
// Sinon on ne peut pas savoir s'il est installé : si la page garde le focus 2,5 s, parcours « Première fois ».
let followTimer = null;
function install(a) {
  location.href = PROTOCOL + encodeURIComponent(a.id);
  if (local) {
    toast(`Le Store Outils Épargne demande confirmation pour installer ${a.name}.`, 7000);
    clearInterval(followTimer);
    const until = Date.now() + 10 * 60000;
    followTimer = setInterval(() => (Date.now() > until ? clearInterval(followTimer) : readLocal()), 5000);
    return;
  }
  let left = false;
  const away = () => { left = true; };
  window.addEventListener('blur', away);
  document.addEventListener('visibilitychange', away);
  toast(`Ouverture du Store Outils Épargne pour installer ${a.name}…`);
  setTimeout(() => {
    window.removeEventListener('blur', away);
    document.removeEventListener('visibilitychange', away);
    if (!left) firstTime(a);
  }, 2500);
}
// LE PARCOURS « PREMIÈRE FOIS » : installer le Store, puis revenir cliquer « Installer ».
function firstTime(a) {
  const store = data.apps.find((x) => x.id === data.storeId);
  const head = a ? `${icon(a)}<div><h3>Il faut d’abord le Store Outils Épargne</h3><div class="meta">pour installer ${esc(a.name)} en un clic</div></div>`
    : `<img class="icon" src="logo.svg" alt=""><div><h3>Première fois ?</h3><div class="meta">Installer le Store Outils Épargne, une fois pour toutes</div></div>`;
  sheet(`<div class="top">${head}<button class="ghost close" data-close title="Fermer">✕</button></div>
    <div class="scroll text">
      <p>Les applis s’installent en un clic par le <b>Store Outils Épargne</b>, un petit programme installé sur votre poste : il télécharge l’appli depuis SharePoint et l’installe en silence. Une page web ne peut pas le faire elle-même.</p>
      <ol class="steps">
        <li><b>Téléchargez le Store.</b> ${store ? `Le dossier partagé SharePoint s’ouvre (connexion Microsoft) : prenez « <b>${esc(store.file)}</b> ».<br><button class="pill primary" data-download="${esc(store.id)}">Télécharger le Store</button>` : 'Il n’est pas encore publié dans le dossier partagé : demandez-le à Arnaud.'}</li>
        <li><b>Installez-le.</b> Dans Téléchargements, clic droit sur le ZIP &gt; « Extraire tout », puis double-clic sur ${store?.installer ? `« <b>${esc(store.installer)}</b> »` : 'son installeur'}. Le Store s’ouvre ; il démarre ensuite avec Windows.</li>
        <li><b>Revenez ici</b>${a ? ` et cliquez de nouveau « Installer » sur ${esc(a.name)}` : ' et cliquez « Installer » sur une appli'}. Le navigateur demande « Ouvrir Store Outils Épargne ? » : cochez « Toujours autoriser », puis « Ouvrir ». S’il demande l’accès aux appareils du réseau local, autorisez-le : c’est ainsi que la page voit ce qui est installé.</li>
      </ol>
      <p class="meta">Le Store est déjà installé ? Lancez-le depuis le menu Démarrer (« Store Outils Épargne ») puis recommencez.</p>
    </div>
    ${a ? `<div class="actions"><span class="meta">Ou sans le Store :</span><button class="pill" data-download="${esc(a.id)}">Télécharger seulement ${esc(a.name)}</button></div>` : ''}`);
}

function showLock(msg = '') {
  $('main').hidden = true;
  $('search').hidden = true;
  $('forget').hidden = true;
  $('lock').hidden = false;
  $('lockMsg').textContent = msg;
  $('sub').textContent = 'Accès réservé à l’équipe';
  $('token').focus();
}
async function open(token, { fromUser } = {}) {
  try {
    data = await unlock(token);
  } catch (e) {
    if (e.bad) remembered.set(null);
    return showLock(fromUser || !e.bad ? e.message : 'Le jeton mémorisé n’est plus valable : saisissez le nouveau.');
  }
  remembered.set(norm(token));
  $('lock').hidden = true;
  $('main').hidden = false;
  $('search').hidden = false;
  $('forget').hidden = false;
  render();
  readLocal();
}
// L'état du poste : relu au retour sur l'onglet et toutes les 20 s tant que la page est visible.
document.addEventListener('visibilitychange', () => { if (!document.hidden && data) readLocal(); });
setInterval(() => { if (!document.hidden && data) readLocal(); }, 20000);

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-detail], [data-zoom], .detail');
  if (!t) return;
  const app = (id) => data?.apps.find((a) => a.id === id);
  if (t.dataset.install) install(app(t.dataset.install));
  else if (t.dataset.download) openShare(app(t.dataset.download));
  else if (t.dataset.web) openWeb(app(t.dataset.web));
  else if (t.hasAttribute('data-first')) firstTime(null);
  else if (t.dataset.detail) showDetail(t.dataset.detail);
  else if (t.dataset.zoom) window.open(t.dataset.zoom, '_blank', 'noopener');
  else if (t.hasAttribute('data-close') || (t.classList.contains('detail') && e.target === t)) $('detail').hidden = true;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('detail').hidden = true; });
$('search').addEventListener('input', (e) => { filter = e.target.value; render(); });
$('lock').addEventListener('submit', (e) => {
  e.preventDefault();
  if (norm($('token').value)) open($('token').value, { fromUser: true });
});
$('forget').addEventListener('click', () => {
  remembered.set(null);
  data = null;
  $('token').value = '';
  showLock('Jeton oublié sur ce navigateur.');
});

// Le lien d'accès : `…/#jeton=XXXX-…` ; le fragment est retiré de l'adresse aussitôt lu (aussi quand
// le lien est collé dans un onglet déjà ouvert sur la page : seul le fragment change, pas de rechargement).
function tokenFromLink() {
  const t = /(?:^#|&)jeton=([^&]+)/.exec(location.hash)?.[1];
  if (t) history.replaceState(null, '', location.pathname + location.search);
  return t ? decodeURIComponent(t) : null;
}
window.addEventListener('hashchange', () => {
  const t = tokenFromLink();
  if (t) open(t, { fromUser: true });
});
const fromLink = tokenFromLink();
const start = fromLink ?? remembered.get();
if (start) open(start, { fromUser: Boolean(fromLink) });
else showLock();
