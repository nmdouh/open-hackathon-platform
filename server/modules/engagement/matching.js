'use strict';

// Explainable, dependency-free skill matching for English and Arabic text.
// A skill that appears in a team's "looking for" text counts most; a skill
// sharing a word with the idea description counts less. The matched skills
// are returned so the UI can say *why* something was suggested.

const STOP = new Set([
  'the', 'and', 'for', 'with', 'our', 'you', 'your', 'are', 'who', 'that', 'this', 'from', 'into', 'will', 'can',
  'need', 'needs', 'looking', 'someone', 'people', 'team', 'help', 'good', 'some', 'any', 'all', 'more',
  'في', 'من', 'على', 'إلى', 'عن', 'مع', 'أن', 'التي', 'الذي', 'هذا', 'هذه', 'نحتاج', 'نبحث', 'فريق',
]);

// Arabic: strip the definite article so "البيانات" matches "بيانات".
function normaliseWord(w) {
  let x = w.replace(/^[.\-_]+|[.\-_]+$/g, '');
  if (/^ال[؀-ۿ]{3,}$/.test(x)) x = x.slice(2);
  return x;
}

function tokens(text) {
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}+#.\-_]+/u)) {
    const w = normaliseWord(raw);
    if (w.length >= 2 && !STOP.has(w)) out.add(w);
  }
  return out;
}

function scoreSkills(skills, { lookingFor = '', context = '' }) {
  const wanted = String(lookingFor).toLowerCase();
  const wantedTokens = tokens(lookingFor);
  const contextTokens = tokens(context);
  const matched = [];
  let score = 0;
  for (const skill of skills || []) {
    const k = String(skill).toLowerCase().trim();
    if (!k) continue;
    const kt = [...tokens(k)];
    if (wanted.includes(k) || (kt.length && kt.every((t) => wantedTokens.has(t)))) {
      score += 3;
      matched.push(skill);
    } else if (kt.some((t) => wantedTokens.has(t) || contextTokens.has(t))) {
      score += 1;
      matched.push(skill);
    }
  }
  return { score, matched };
}

module.exports = { tokens, scoreSkills };
