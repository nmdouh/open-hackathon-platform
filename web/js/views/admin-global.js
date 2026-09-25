import { api } from '../api.js';
import { t } from '../i18n.js';
import { h, badge, busy, field, formValues, fmtDate } from '../ui.js';
import { state, isAdmin } from '../state.js';
import { go, refresh } from '../app.js';
import { auditTable } from './admin-hackathon.js';

function createForm() {
  const form = h('form', { class: 'form card' },
    h('h2', null, t('home.createHackathon')),
    field(t('admin.slug'), h('input', { type: 'text', name: 'slug', required: true, pattern: '[a-z0-9][a-z0-9\\-]{1,62}', placeholder: 'spring-2027' }), t('admin.slugHint')),
    field(t('admin.titleEn'), h('input', { type: 'text', name: 'titleEn', required: true, maxlength: 200 })),
    field(t('admin.titleAr'), h('input', { type: 'text', name: 'titleAr', maxlength: 200, dir: 'rtl', lang: 'ar' })),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('admin.create'))));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const { hackathon } = await api.post('/hackathons', formValues(form));
      go(`h/${hackathon.slug}/admin/settings`);
    });
  });
  return form;
}

async function usersCard(query) {
  const { users } = await api.get(`/admin/users${query ? `?q=${encodeURIComponent(query)}` : ''}`);
  const search = h('form', { class: 'row' },
    h('input', { type: 'search', name: 'q', value: query, placeholder: t('admin.searchUsers'), 'aria-label': t('admin.searchUsers') }),
    h('button', { class: 'btn btn--secondary btn--small', type: 'submit' }, t('common.search')));
  search.addEventListener('submit', (e) => { e.preventDefault(); go(`admin?q=${encodeURIComponent(formValues(search).q)}`); });
  return h('section', { class: 'card stack-sm' },
    h('h2', null, t('admin.users')),
    search,
    h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, t('admin.col.name')), h('th', null, t('admin.col.role')), h('th', null, t('admin.lastLogin')), h('th', null, ''))),
      h('tbody', null, users.map((u) => h('tr', null,
        h('td', null, u.displayName, h('div', { class: 'small muted' }, u.email)),
        h('td', null, badge(t(`userRole.${u.role}`), u.role === 'admin' ? 'info' : ''), u.isActive ? null : [' ', badge(t('admin.inactive'), 'danger')]),
        h('td', { class: 'small' }, fmtDate(u.lastLoginAt)),
        h('td', null, u.id === state.user.id ? null : h('div', { class: 'row' },
          h('button', {
            class: 'btn btn--ghost btn--small',
            onclick: (e) => busy(e.target, async () => { await api.patch(`/admin/users/${u.id}`, { role: u.role === 'admin' ? 'user' : 'admin' }); refresh(); }),
          }, u.role === 'admin' ? t('admin.removeAdmin') : t('admin.makeAdmin')),
          h('button', {
            class: 'btn btn--ghost btn--small',
            onclick: (e) => busy(e.target, async () => { await api.patch(`/admin/users/${u.id}`, { isActive: !u.isActive }); refresh(); }),
          }, u.isActive ? t('admin.deactivate') : t('admin.activate'))))))))));
}

export async function adminGlobalView({ query }) {
  if (!isAdmin()) return h('div', { class: 'notice notice--danger' }, t('error.ADMIN_ONLY'));
  return h('div', { class: 'stack' },
    h('div', { class: 'hero' }, h('h1', null, t('admin.title'))),
    h('div', { class: 'grid-2' }, createForm(), await usersCard(query.get('q') || '')),
    h('section', { class: 'stack-sm' }, h('h2', null, t('admin.auditLog')), await auditTable('')));
}
