import { api } from '../api.js';
import { t, lang, setLang } from '../i18n.js';
import { h, field, busy, toast, formValues } from '../ui.js';
import { state } from '../state.js';
import { go, render } from '../app.js';

function nextPath(query) {
  const next = query && query.get('next');
  // Only in-app paths; never an absolute URL.
  return next && /^[\w\-/]+$/.test(next) ? next : '';
}

export function loginView({ query }) {
  const form = h('form', { class: 'form card', novalidate: true },
    h('h1', null, t('auth.loginTitle')),
    field(t('auth.email'), h('input', { type: 'email', name: 'email', required: true, autocomplete: 'username' })),
    field(t('auth.password'), h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' })),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('nav.login'))),
    state.config.allowSignup ? h('p', { class: 'small' }, t('auth.noAccount'), ' ', h('a', { href: '#/signup' }, t('nav.signup'))) : null);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('button[type=submit]'), async () => {
      const { user } = await api.post('/auth/login', formValues(form));
      state.user = user;
      if (user.locale && user.locale !== lang()) setLang(user.locale);
      go(nextPath(query));
      render();
    });
  });
  return h('div', { class: 'narrow' }, form);
}

export function signupView({ query }) {
  if (!state.config.allowSignup) return h('div', { class: 'notice' }, t('auth.signupDisabled'));
  const form = h('form', { class: 'form card', novalidate: true },
    h('h1', null, t('auth.signupTitle')),
    field(t('auth.displayName'), h('input', { type: 'text', name: 'displayName', required: true, maxlength: 120, autocomplete: 'name' })),
    field(t('auth.email'), h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email' })),
    field(t('auth.password'), h('input', { type: 'password', name: 'password', required: true, minlength: 10, autocomplete: 'new-password' }), t('auth.passwordHint')),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('auth.createAccount'))),
    h('p', { class: 'small' }, t('auth.haveAccount'), ' ', h('a', { href: '#/login' }, t('nav.login'))));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('button[type=submit]'), async () => {
      const { user } = await api.post('/auth/signup', { ...formValues(form), locale: lang() });
      state.user = user;
      toast(t('auth.welcome'));
      go(nextPath(query));
      render();
    });
  });
  return h('div', { class: 'narrow' }, form);
}

export function profileView() {
  const profile = h('form', { class: 'form card' },
    h('h2', null, t('profile.title')),
    field(t('auth.email'), h('input', { type: 'email', value: state.user.email, disabled: true })),
    field(t('auth.displayName'), h('input', { type: 'text', name: 'displayName', value: state.user.displayName, required: true, maxlength: 120 })),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('common.save'))));
  profile.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(profile.querySelector('button[type=submit]'), async () => {
      const { user } = await api.patch('/auth/me', formValues(profile));
      state.user = user;
      toast(t('common.saved'));
      render();
    });
  });
  const pw = h('form', { class: 'form card' },
    h('h2', null, t('profile.changePassword')),
    field(t('profile.currentPassword'), h('input', { type: 'password', name: 'currentPassword', required: true, autocomplete: 'current-password' })),
    field(t('profile.newPassword'), h('input', { type: 'password', name: 'newPassword', required: true, minlength: 10, autocomplete: 'new-password' }), t('auth.passwordHint')),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('profile.changePassword'))));
  pw.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(pw.querySelector('button[type=submit]'), async () => {
      await api.post('/auth/password', formValues(pw));
      pw.reset();
      toast(t('profile.passwordChanged'));
    });
  });
  return h('div', { class: 'narrow stack' }, profile, pw);
}
