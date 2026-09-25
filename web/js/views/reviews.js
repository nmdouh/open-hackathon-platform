import { api, enc } from '../api.js';
import { t } from '../i18n.js';
import { h, pick, badge, emptyState, busy, toast, fmtNum, confirmDialog } from '../ui.js';
import { refresh, go } from '../app.js';
import { hackCtx, shell, trackName } from './shell.js';
import { ideaDetails } from './ideas.js';

const ROUND_BADGE = { draft: '', open: 'ok', closed: 'warn', finalized: 'info' };
const OUTCOME_BADGE = { advance: 'ok', waitlist: 'warn', reject: 'danger' };

export function roundBadge(status) {
  return badge(t(`roundStatus.${status}`), ROUND_BADGE[status]);
}

export async function reviewsView({ slug }) {
  const ctx = await hackCtx(slug);
  const base = `#/h/${enc(slug)}/reviews`;
  return shell(ctx, 'reviews',
    h('p', { class: 'muted' }, t('reviews.lead')),
    ctx.rounds.length ? h('div', { class: 'grid' }, ctx.rounds.map((r) => h('article', { class: 'card stack-sm' },
      h('div', { class: 'card__title' }, h('h3', null, h('a', { href: `${base}/${r.id}` }, pick(r, 'name'))), roundBadge(r.status)),
      h('div', { class: 'small muted' }, t(`roundKind.${r.kind}`), ' · ', t('reviews.reviewersCount', { n: r.reviewerCount })),
      r.iChair ? badge(t('reviews.youChair'), 'info') : r.iReview ? badge(t('reviews.youReview')) : null)))
      : emptyState(ctx.admin ? t('reviews.noneAdmin') : t('reviews.none')));
}

function boardTable(ctx, round, board) {
  const canChange = ['open', 'closed'].includes(round.status);
  const decide = async (row, outcome, button) => {
    const needsNote = row.suggestion !== outcome;
    let note = '';
    if (needsNote) {
      note = await confirmDialog(t('board.overridePrompt', { suggestion: row.suggestion ? t(`outcome.${row.suggestion}`) : t('board.noSuggestion') }),
        { withNote: true, notePlaceholder: t('board.overrideReason'), okLabel: t('board.record') });
      if (note === null) return;
    }
    busy(button, async () => {
      await api.put(`/rounds/${round.id}/decisions/${row.ideaId}`, { outcome, note });
      toast(t('board.recorded'));
      refresh();
    });
  };
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null,
      h('th', { class: 'num' }, '#'), h('th', null, t('board.candidate')), h('th', { class: 'num' }, t('board.score')),
      h('th', { class: 'num' }, t('board.votes')), h('th', null, t('board.recommendations')),
      h('th', null, t('board.suggestion')), h('th', null, t('board.decision')))),
    h('tbody', null, board.rows.map((row) => {
      const a = row.aggregate;
      return h('tr', null,
        h('td', { class: 'num' }, row.rank ?? '—'),
        h('td', null,
          h('a', { href: `#/h/${enc(ctx.slug)}/reviews/${round.id}/${row.ideaId}` }, row.idea.title),
          h('div', { class: 'small muted' }, row.idea.teamName || '', trackName(row.idea) ? ` · ${trackName(row.idea)}` : '')),
        h('td', { class: 'num' },
          h('strong', null, fmtNum(a.score)),
          a.reviewerCount > 1 ? h('div', { class: 'small muted', title: t('board.spread') }, `± ${fmtNum(a.spread)}`) : null),
        h('td', { class: 'num' }, `${a.reviewerCount}`, a.meetsMinimum ? null : h('div', null, badge(t('board.belowMinimum'), 'warn')),
          a.conflicts ? h('div', { class: 'small muted' }, t('board.conflicts', { n: a.conflicts })) : null),
        h('td', { class: 'small nowrap' }, `✓ ${a.recommendations.advance} · ~ ${a.recommendations.hold} · ✗ ${a.recommendations.reject}`),
        h('td', null, row.suggestion ? badge(t(`outcome.${row.suggestion}`), OUTCOME_BADGE[row.suggestion]) : h('span', { class: 'muted' }, '—')),
        h('td', null,
          row.decision ? h('div', null, badge(t(`outcome.${row.decision.outcome}`), OUTCOME_BADGE[row.decision.outcome]),
            row.decision.isOverride ? h('div', { class: 'small muted', title: row.decision.note }, t('board.override')) : null) : null,
          canChange ? h('div', { class: 'row' }, ['advance', 'waitlist', 'reject'].map((o) => h('button', {
            class: `btn btn--small ${row.decision && row.decision.outcome === o ? '' : 'btn--secondary'}`,
            onclick: (e) => decide(row, o, e.target),
          }, t(`outcome.${o}`)))) : null));
    }))));
}

export async function roundView({ slug, roundId }) {
  const ctx = await hackCtx(slug);
  const detail = await api.get(`/rounds/${enc(roundId)}`);
  const { round, access } = detail;
  const parts = [];
  if (access.reviewer) {
    const { candidates } = await api.get(`/rounds/${round.id}/my-candidates`);
    const done = candidates.filter((c) => c.myStatus === 'submitted').length;
    parts.push(h('section', { class: 'card stack-sm' },
      h('div', { class: 'row row--between' }, h('h2', null, t('reviews.myQueue')), h('span', { class: 'muted' }, t('reviews.progress', { done, total: candidates.length }))),
      round.status !== 'open' ? h('div', { class: 'notice notice--warn' }, t('reviews.notOpen')) : null,
      candidates.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('tbody', null, candidates.map((c) => h('tr', null,
          h('td', null, h('a', { href: `#/h/${enc(slug)}/reviews/${round.id}/${c.id}` }, c.title), h('div', { class: 'small muted' }, c.teamName || '')),
          h('td', null, c.autoConflict ? badge(t('reviews.conflict'), 'danger')
            : c.myConflict ? badge(t('reviews.declaredConflict'), 'warn')
              : c.myStatus === 'submitted' ? badge(t('reviews.submitted'), 'ok')
                : c.myStatus === 'draft' ? badge(t('reviews.draft'), 'info') : badge(t('reviews.todo'))),
          h('td', { class: 'num' }, c.myTotal !== null && c.myTotal !== undefined ? fmtNum(c.myTotal) : '')))))) : emptyState(t('reviews.noCandidates'))));
  }
  if (access.canDecide && round.status !== 'draft') {
    const board = await api.get(`/rounds/${round.id}/board`);
    const undecided = board.rows.filter((r) => !r.decision).length;
    parts.push(h('section', { class: 'card stack-sm' },
      h('div', { class: 'row row--between' }, h('h2', null, t('board.title')), roundBadge(round.status)),
      h('p', { class: 'muted small' }, t('board.lead', { min: round.minReviewers }),
        round.advanceCount !== null ? ` ${t('board.quota', { n: round.advanceCount })}` : ` ${t('board.majority')}`),
      board.rows.length ? boardTable(ctx, round, board) : emptyState(t('reviews.noCandidates')),
      round.status === 'closed' ? h('div', { class: 'row' },
        h('span', { class: 'muted' }, t('board.undecided', { n: undecided })),
        h('button', {
          class: 'btn',
          onclick: async (e) => {
            if (!(await confirmDialog(t('board.finalizeConfirm', { n: undecided })))) return;
            busy(e.target, async () => { await api.post(`/rounds/${round.id}/finalize`, { applySuggestions: true }); toast(t('board.finalized')); refresh(); });
          },
        }, t('board.finalize'))) : null,
      round.status === 'open' ? h('p', { class: 'small muted' }, t('board.closeFirst')) : null));
  }
  return shell(ctx, 'reviews',
    h('div', { class: 'row' }, h('h2', null, pick(round, 'name')), roundBadge(round.status),
      ctx.admin ? h('a', { class: 'btn btn--secondary btn--small', href: `#/h/${enc(slug)}/admin/rounds/${round.id}` }, t('reviews.configure')) : null),
    h('div', { class: 'stack' }, parts));
}

function scaleInput(criterion, value, disabled) {
  const options = [];
  for (let v = criterion.minScore; v <= criterion.maxScore; v++) options.push(v);
  return h('div', { class: 'scale', role: 'radiogroup', 'aria-label': pick(criterion, 'name') },
    options.map((v) => h('label', null,
      h('input', { type: 'radio', name: `c_${criterion.id}`, value: String(v), checked: Number(value) === v, disabled }),
      h('span', null, String(v)))));
}

export async function scoreView({ slug, roundId, ideaId }) {
  const ctx = await hackCtx(slug);
  const d = await api.get(`/rounds/${enc(roundId)}/candidates/${enc(ideaId)}`);
  const { round, idea, criteria, evaluation, autoConflict } = d;
  const ev = evaluation || { scores: {}, comment: '', recommendation: null, status: null };
  const locked = round.status !== 'open' || Boolean(autoConflict) || ev.conflict;
  const form = h('form', { class: 'form card' },
    h('h2', null, t('score.title')),
    autoConflict ? h('div', { class: 'notice notice--danger' }, t(`conflict.${autoConflict}`)) : null,
    ev.conflict ? h('div', { class: 'notice notice--warn' }, t('score.conflictDeclared'), ': ', ev.conflictReason) : null,
    ev.status === 'submitted' && !ev.conflict ? h('div', { class: 'notice notice--ok' }, t('score.alreadySubmitted', { total: fmtNum(ev.total) })) : null,
    criteria.map((c) => h('div', { class: 'criterion' },
      h('div', { class: 'row row--between' }, h('strong', null, pick(c, 'name')), h('span', { class: 'small muted' }, t('score.weight', { w: fmtNum(c.weight) }))),
      pick(c, 'description') ? h('p', { class: 'small muted' }, pick(c, 'description')) : null,
      scaleInput(c, ev.scores[c.id], locked))),
    round.kind === 'screening' ? h('fieldset', null, h('legend', null, t('score.recommendation')),
      ['advance', 'hold', 'reject'].map((r) => h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'recommendation', value: r, checked: ev.recommendation === r, disabled: locked }), t(`recommendation.${r}`)))) : null,
    h('label', { class: 'field' }, h('span', null, t('score.comment')), h('textarea', { name: 'comment', maxlength: 4000, value: ev.comment, disabled: locked })),
    locked ? null : h('div', { class: 'form-actions' },
      ev.status !== 'submitted' ? h('button', { class: 'btn btn--secondary', type: 'submit', value: 'draft' }, t('score.saveDraft')) : null,
      h('button', { class: 'btn', type: 'submit', value: 'submit' }, ev.status === 'submitted' ? t('score.resubmit') : t('score.submit')),
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: (e) => declareConflict(round, idea, e.target, slug) }, t('score.declareConflict'))));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const submit = e.submitter && e.submitter.value === 'submit';
    const scores = {};
    for (const c of criteria) {
      const checked = form.querySelector(`input[name="c_${c.id}"]:checked`);
      if (checked) scores[c.id] = Number(checked.value);
    }
    const rec = form.querySelector('input[name="recommendation"]:checked');
    busy(e.submitter, async () => {
      await api.put(`/rounds/${round.id}/candidates/${idea.id}/evaluation`, {
        scores, comment: form.elements.comment.value, recommendation: rec ? rec.value : null, submit,
      });
      toast(submit ? t('score.submittedToast') : t('common.saved'));
      if (submit) go(`h/${enc(slug)}/reviews/${round.id}`); else refresh();
    });
  });
  return shell(ctx, 'reviews',
    h('p', null, h('a', { href: `#/h/${enc(slug)}/reviews/${round.id}` }, `← ${pick(round, 'name')}`)),
    h('div', { class: 'grid-2' },
      h('article', { class: 'card stack-sm' },
        h('h2', null, idea.title),
        h('div', { class: 'small muted' }, idea.teamName ? `${t('team.team')}: ${idea.teamName}` : t('score.noTeam'), trackName(idea) ? ` · ${trackName(idea)}` : ''),
        d.members.length ? h('div', { class: 'small' }, d.members.map((m) => m.displayName).join(', ')) : null,
        ideaDetails(idea)),
      form));
}

async function declareConflict(round, idea, button, slug) {
  const reason = await confirmDialog(t('score.conflictPrompt'), { withNote: true, notePlaceholder: t('score.conflictReason'), okLabel: t('score.declareConflict'), danger: true });
  if (!reason) return;
  busy(button, async () => {
    await api.put(`/rounds/${round.id}/candidates/${idea.id}/evaluation`, { conflict: true, conflictReason: reason });
    toast(t('score.conflictRecorded'));
    go(`h/${enc(slug)}/reviews/${round.id}`);
  });
}
