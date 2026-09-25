import { api, enc } from '../api.js';
import { t } from '../i18n.js';
import { h, badge, emptyState, fmtDate } from '../ui.js';
import { hackCtx, shell, trackName } from './shell.js';

export function ideaDetails(idea) {
  const rows = [
    ['problem', idea.problem], ['solution', idea.solution], ['targetUsers', idea.targetUsers],
    ['expectedImpact', idea.expectedImpact], ['dataAndTools', idea.dataAndTools],
  ].filter(([, v]) => v);
  return h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', null, t(`idea.${k}`)), h('dd', null, v)]));
}

export async function ideasView({ slug }) {
  const ctx = await hackCtx(slug);
  const { ideas } = await api.get(`/hackathons/${ctx.h.id}/ideas`);
  return shell(ctx, 'ideas',
    ideas.length ? h('div', { class: 'grid' }, ideas.map((i) => h('article', { class: 'card stack-sm' },
      h('div', { class: 'card__title' },
        h('h3', null, h('a', { href: `#/h/${enc(slug)}/ideas/${i.id}` }, i.title)),
        i.status !== 'submitted' ? badge(t(`ideaStatus.${i.status}`), 'warn') : null),
      h('div', { class: 'small muted' }, i.ownerName, trackName(i) ? ` · ${trackName(i)}` : ''),
      i.problem ? h('p', { class: 'pre' }, i.problem.length > 220 ? `${i.problem.slice(0, 220)}…` : i.problem) : null,
      i.teamName ? badge(`${t('team.team')}: ${i.teamName}`, 'info') : null)))
      : emptyState(t('ideas.none')));
}

export async function ideaView({ slug, id }) {
  const ctx = await hackCtx(slug);
  const { idea } = await api.get(`/ideas/${enc(id)}`);
  return shell(ctx, 'ideas',
    h('article', { class: 'card stack' },
      h('div', { class: 'card__title' }, h('h2', null, idea.title), badge(t(`ideaStatus.${idea.status}`))),
      h('div', { class: 'small muted' }, idea.ownerName, trackName(idea) ? ` · ${trackName(idea)}` : '', idea.submittedAt ? ` · ${fmtDate(idea.submittedAt)}` : ''),
      ideaDetails(idea)),
    h('p', null, h('a', { href: `#/h/${enc(slug)}/ideas` }, t('common.back'))));
}
