import { api } from './api.js';
import { t, lang, setLang, hasStoredLang, errorText } from './i18n.js';
import { h, mount, busy } from './ui.js';
import { state } from './state.js';
import { homeView } from './views/home.js';
import { loginView, signupView, profileView } from './views/auth.js';
import { overviewView } from './views/overview.js';
import { participateView } from './views/participate.js';
import { ideasView, ideaView } from './views/ideas.js';
import { teamsView, teamView } from './views/teams.js';
import { progressView } from './views/progress.js';
import { mentoringView } from './views/mentoring.js';
import { toolboxView } from './views/toolbox.js';
import { reviewsView, roundView, scoreView } from './views/reviews.js';
import { adminHackathonView, adminRoundView } from './views/admin-hackathon.js';
import { adminGlobalView } from './views/admin-global.js';

// Route patterns: ":name" captures a segment.
const ROUTES = [
  ['', homeView],
  ['login', loginView],
  ['signup', signupView],
  ['profile', profileView, { auth: true }],
  ['admin', adminGlobalView, { auth: true }],
  ['h/:slug', overviewView],
  ['h/:slug/me', participateView, { auth: true }],
  ['h/:slug/ideas', ideasView, { auth: true }],
  ['h/:slug/ideas/:id', ideaView, { auth: true }],
  ['h/:slug/teams', teamsView, { auth: true }],
  ['h/:slug/teams/:id', teamView, { auth: true }],
  ['h/:slug/progress', progressView, { auth: true }],
  ['h/:slug/mentoring', mentoringView, { auth: true }],
  ['h/:slug/toolbox', toolboxView, { auth: true }],
  ['h/:slug/reviews', reviewsView, { auth: true }],
  ['h/:slug/reviews/:roundId', roundView, { auth: true }],
  ['h/:slug/reviews/:roundId/:ideaId', scoreView, { auth: true }],
  ['h/:slug/admin', adminHackathonView, { auth: true }],
  ['h/:slug/admin/:tab', adminHackathonView, { auth: true }],
  ['h/:slug/admin/rounds/:roundId', adminRoundView, { auth: true }],
];

function match(path) {
  const parts = path.split('/').filter(Boolean);
  for (const [pattern, view, opts = {}] of ROUTES) {
    const pp = pattern.split('/').filter(Boolean);
    if (pp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (pp[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { view, params, opts };
  }
  return null;
}

function currentPath() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { path, query: new URLSearchParams(query) };
}

export function go(path) {
  location.hash = `#/${path.replace(/^\//, '')}`;
}

let renderSeq = 0;
export async function render() {
  const seq = ++renderSeq;
  const app = document.getElementById('app');
  const { path, query } = currentPath();
  const m = match(path);
  renderChrome();
  if (!m) {
    mount(app, h('div', { class: 'empty' }, t('common.notFound'), ' ', h('a', { href: '#/' }, t('nav.home'))));
    return;
  }
  if (m.opts.auth && !state.user) {
    go(`login?next=${encodeURIComponent(path)}`);
    return;
  }
  try {
    const node = await m.view({ ...m.params, query });
    if (seq !== renderSeq) return; // a newer navigation won
    mount(app, node);
  } catch (err) {
    if (seq !== renderSeq) return;
    if (err && err.status === 401) { state.user = null; go(`login?next=${encodeURIComponent(path)}`); return; }
    mount(app, h('div', { class: 'notice notice--danger' }, errorText(err)));
  }
}

// Re-renders the current view in place (after a change).
export function refresh() {
  return render();
}

function renderChrome() {
  document.documentElement.lang = lang();
  document.documentElement.dir = lang() === 'ar' ? 'rtl' : 'ltr';
  const name = (state.config && state.config.appName) || t('app.name');
  document.getElementById('brand-name').textContent = name;
  document.title = name;
  document.getElementById('skip-link').textContent = t('nav.skip');
  const toggle = document.getElementById('lang-toggle');
  toggle.textContent = lang() === 'ar' ? 'English' : 'العربية';
  toggle.lang = lang() === 'ar' ? 'en' : 'ar';
  document.getElementById('theme-toggle').setAttribute('aria-label', t('nav.theme'));
  mount(document.getElementById('footer-text'), t('app.footer'));
  const account = document.getElementById('account');
  if (state.user) {
    mount(account,
      state.user.role === 'admin' ? h('a', { class: 'btn btn--ghost', href: '#/admin' }, t('nav.admin')) : null,
      h('a', { class: 'btn btn--ghost', href: '#/profile', title: state.user.email }, state.user.displayName),
      h('button', { type: 'button', class: 'btn btn--secondary btn--small', onclick: (e) => busy(e.currentTarget, logout) }, t('nav.logout')));
  } else {
    mount(account,
      h('a', { class: 'btn btn--ghost', href: '#/login' }, t('nav.login')),
      state.config && state.config.allowSignup ? h('a', { class: 'btn btn--small', href: '#/signup' }, t('nav.signup')) : null);
  }
}

async function logout() {
  await api.post('/auth/logout');
  state.user = null;
  go('');
  render();
}

// ---- theme ----
const THEME_KEY = 'ohp.theme';
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
function storedTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}
function toggleTheme() {
  const current = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
}

async function boot() {
  applyTheme(storedTheme());
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('lang-toggle').addEventListener('click', () => {
    setLang(lang() === 'ar' ? 'en' : 'ar');
    if (state.user) api.patch('/auth/me', { locale: lang() }).catch(() => {});
    render();
  });
  const [config, me] = await Promise.all([api.get('/config'), api.get('/auth/me')]);
  state.config = config;
  state.user = me.user;
  if (state.user && !hasStoredLang()) setLang(state.user.locale);
  window.addEventListener('hashchange', () => {
    render();
    document.getElementById('main').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });
  await render();
}

boot().catch((err) => {
  mount(document.getElementById('app'), h('div', { class: 'notice notice--danger' }, errorText(err)));
});
