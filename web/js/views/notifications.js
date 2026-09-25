import { api } from '../api.js';
import { t } from '../i18n.js';
import { h, busy, emptyState, fmtRelative, fmtDate, pick } from '../ui.js';
import { go, refresh } from '../app.js';

// Turns a stored notification into a sentence in the reader's language.
export function notificationText(n) {
  const d = n.data || {};
  return t(`notif.${n.kind}`, {
    team: d.teamName || '', person: d.personName || '', topic: d.topic || '',
    title: pick(d, 'title'), name: pick(d, 'name'),
  });
}

function safeLink(link) {
  // Links are in-app paths only.
  return /^[\w\-/]+$/.test(link || '') ? link : '';
}

export async function notificationsView() {
  const { notifications, unread } = await api.get('/notifications?limit=100');
  const open = (n) => async (e) => {
    e.preventDefault();
    if (!n.readAt) await api.post('/notifications/read', { ids: [n.id] }).catch(() => {});
    const link = safeLink(n.link);
    if (link) go(link); else refresh();
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'hero row row--between' },
      h('h1', null, t('notif.title')),
      unread ? h('button', {
        class: 'btn btn--secondary btn--small',
        onclick: (e) => busy(e.target, async () => { await api.post('/notifications/read', { all: true }); refresh(); }),
      }, t('notif.markAll')) : null),
    notifications.length
      ? h('ul', { class: 'notice-list card' }, notifications.map((n) => h('li', { class: n.readAt ? '' : 'is-unread' },
        h('span', { class: `dot${n.readAt ? ' dot--read' : ''}`, 'aria-hidden': 'true' }),
        h('div', null,
          h('a', { href: `#/${safeLink(n.link)}`, onclick: open(n) }, notificationText(n)),
          h('div', { class: 'small muted' }, h('time', { datetime: n.createdAt, title: fmtDate(n.createdAt) }, fmtRelative(n.createdAt)))))))
      : emptyState(t('notif.none')));
}
