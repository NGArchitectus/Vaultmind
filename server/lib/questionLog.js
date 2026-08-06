"use strict";

// Group vault_question_history rows into the admin Q&A log shape:
// [{ userId, name, count, lastAsked, questions: [{ question, vaultName, askedAt }] }]
// People sorted by most recent question; each person's questions newest first.
// Only people who have asked something appear (rows drive the output).
function groupQuestionsByPerson(rows, nameById) {
  const byUser = new Map();
  for (const r of rows || []) {
    if (!byUser.has(r.user_id)) {
      byUser.set(r.user_id, {
        userId: r.user_id,
        name: (nameById || {})[r.user_id] || r.user_id.slice(0, 8) + "…",
        questions: [],
      });
    }
    byUser.get(r.user_id).questions.push({
      question: r.question,
      vaultName: r.vault_name || "—",
      askedAt: r.created_at,
    });
  }
  return [...byUser.values()]
    .map((p) => {
      p.questions.sort((a, b) => (a.askedAt < b.askedAt ? 1 : -1));
      return { ...p, count: p.questions.length, lastAsked: p.questions[0]?.askedAt || null };
    })
    .sort((a, b) => (a.lastAsked < b.lastAsked ? 1 : -1));
}

module.exports = { groupQuestionsByPerson };
