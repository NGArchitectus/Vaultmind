"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { groupQuestionsByPerson } = require("./questionLog");

const rows = [
  { user_id: "u1", vault_name: "Part B", question: "Fire door spec?", created_at: "2026-07-20T10:00:00Z" },
  { user_id: "u2", vault_name: "Part M", question: "Ramp gradients?", created_at: "2026-07-21T09:00:00Z" },
  { user_id: "u1", vault_name: "NHBC",   question: "Cavity trays?",   created_at: "2026-07-19T15:00:00Z" },
];
const nameById = { u1: "Sarah", u2: "Tom" };

test("groups rows by person, most recently active person first", () => {
  const out = groupQuestionsByPerson(rows, nameById);
  assert.deepEqual(out.map((p) => p.name), ["Tom", "Sarah"]);
  assert.equal(out[1].count, 2);
  assert.equal(out[0].count, 1);
});

test("each person's questions are newest first with vault and timestamp", () => {
  const out = groupQuestionsByPerson(rows, nameById);
  const sarah = out.find((p) => p.userId === "u1");
  assert.deepEqual(sarah.questions.map((q) => q.question), ["Fire door spec?", "Cavity trays?"]);
  assert.equal(sarah.questions[0].vaultName, "Part B");
  assert.equal(sarah.questions[0].askedAt, "2026-07-20T10:00:00Z");
  assert.equal(sarah.lastAsked, "2026-07-20T10:00:00Z");
});

test("unknown users fall back to a shortened id and missing vault to a dash", () => {
  const out = groupQuestionsByPerson(
    [{ user_id: "abcdef1234567890", vault_name: null, question: "Q?", created_at: "2026-07-01T00:00:00Z" }],
    {}
  );
  assert.equal(out[0].name, "abcdef12…");
  assert.equal(out[0].questions[0].vaultName, "—");
});

test("empty input gives an empty list", () => {
  assert.deepEqual(groupQuestionsByPerson([], {}), []);
  assert.deepEqual(groupQuestionsByPerson(undefined, {}), []);
});
