import { api } from '../api.js';
import { t } from '../i18n.js';
import { h, badge, busy, field, formValues, fmtDate, toast, confirmDialog } from '../ui.js';
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

// AI coach settings. The API key is write-only: the server never returns it,
// only whether one is stored and its last four characters.
async function aiCard() {
  const { llm } = await api.get('/admin/settings/llm');
  const result = h('div', { 'aria-live': 'polite' });
  const keyInput = h('input', {
    type: 'password', name: 'apiKey', autocomplete: 'off', spellcheck: 'false', maxlength: 1000,
    placeholder: llm.apiKeySet ? t('admin.ai.apiKeyKeep') : t('admin.ai.apiKeyPlaceholder'),
    disabled: !llm.canStoreKey,
  });
  const form = h('form', { class: 'form' },
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'enabled', checked: llm.enabled && Boolean(llm.endpoint) }), h('strong', null, t('admin.ai.enabled'))),
    field(t('admin.ai.endpoint'), h('input', { type: 'url', name: 'endpoint', value: llm.endpoint, placeholder: 'https://api.openai.com/v1/chat/completions', maxlength: 500 }), t('admin.ai.endpointHint')),
    field(t('admin.ai.model'), h('input', { type: 'text', name: 'model', value: llm.model, placeholder: 'gpt-4o-mini', maxlength: 200 }), t('admin.ai.modelHint')),
    field(t('admin.ai.apiKey'), keyInput,
      llm.apiKeyUnreadable ? t('admin.ai.keyUnreadable')
        : llm.apiKeySet ? t('admin.ai.apiKeyStored', { hint: llm.apiKeyHint })
          : llm.canStoreKey ? t('admin.ai.apiKeyNone') : t('admin.ai.secretMissing')),
    llm.apiKeySet ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'clearKey' }), t('admin.ai.clearKey')) : null,
    h('div', { class: 'row' },
      field(t('admin.ai.dailyLimit'), h('input', { type: 'number', name: 'dailyLimit', min: 1, max: 1000, value: llm.dailyLimit || 20 })),
      field(t('admin.ai.timeout'), h('input', { type: 'number', name: 'timeoutSec', min: 5, max: 180, value: Math.round((llm.timeoutMs || 45000) / 1000) }))),
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn', type: 'submit' }, t('common.save')),
      h('button', {
        class: 'btn btn--secondary', type: 'button',
        onclick: (e) => busy(e.target, async () => {
          result.replaceChildren(h('p', { class: 'muted' }, t('admin.ai.testing')));
          try {
            const r = await api.post('/admin/settings/llm/test');
            result.replaceChildren(h('div', { class: 'notice notice--ok' }, t('admin.ai.testOk', { ms: r.latencyMs, reply: r.reply })));
          } catch (err) {
            result.replaceChildren();
            throw err;
          }
        }),
      }, t('admin.ai.test')),
      llm.source === 'database' ? h('button', {
        class: 'btn btn--ghost', type: 'button',
        onclick: async (e) => {
          if (!(await confirmDialog(t('admin.ai.resetConfirm')))) return;
          busy(e.target, async () => { await api.del('/admin/settings/llm'); await reloadConfig(); refresh(); });
        },
      }, t('admin.ai.reset')) : null));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const v = formValues(form);
      const body = {
        enabled: v.enabled, endpoint: v.endpoint.trim(), model: v.model.trim(),
        dailyLimit: v.dailyLimit || 20, timeoutMs: (v.timeoutSec || 45) * 1000,
      };
      if (v.clearKey) body.apiKey = '';
      else if (keyInput.value.trim()) body.apiKey = keyInput.value.trim();
      await api.put('/admin/settings/llm', body);
      keyInput.value = '';
      await reloadConfig();
      toast(t('admin.ai.saved'));
      refresh();
    });
  });
  return h('section', { class: 'card stack-sm', id: 'ai-coach' },
    h('div', { class: 'row row--between' },
      h('h2', null, t('admin.ai.title')),
      state.config.aiEnabled ? badge(t('admin.ai.on'), 'ok') : badge(t('admin.ai.off'), 'warn')),
    h('p', { class: 'muted small' }, t('admin.ai.lead')),
    h('p', { class: 'small' }, llm.source === 'database'
      ? t('admin.ai.sourceDb', { date: fmtDate(llm.updatedAt) }) : t('admin.ai.sourceEnv')),
    form,
    result);
}

async function reloadConfig() {
  state.config = await api.get('/config');
}

export async function adminGlobalView({ query }) {
  if (!isAdmin()) return h('div', { class: 'notice notice--danger' }, t('error.ADMIN_ONLY'));
  return h('div', { class: 'stack' },
    h('div', { class: 'hero' }, h('h1', null, t('admin.title'))),
    h('div', { class: 'grid-2' },
      h('div', { class: 'stack' }, createForm(), await aiCard()),
      await usersCard(query.get('q') || '')),
    h('section', { class: 'stack-sm' }, h('h2', null, t('admin.auditLog')), await auditTable('')));
}
