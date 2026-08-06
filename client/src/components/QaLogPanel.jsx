import React, { useState, useEffect } from "react";
import { api } from "../api/client";
import { DESIGN_SHELL, DESIGN_TEXT, VAULT_FULL } from "../constants";

// Admin → Q&A Log: vault Q&A questions grouped by person (expandable), newest
// activity first. Read-only view over vault_question_history — usage oversight,
// not an audit trail (users can clear their own history; re-asks keep one entry).
export default function QaLogPanel() {
  const [people,     setPeople]     = useState(null); // null = loading
  const [error,      setError]      = useState(false);
  const [search,     setSearch]     = useState("");
  const [openPerson, setOpenPerson] = useState(null);

  useEffect(() => {
    api("/api/admin/question-log")
      .then(resp => setPeople(resp?.people || []))
      .catch(() => { setError(true); setPeople([]); });
  }, []);

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
      + ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };

  // Search filters question text (and person names); people with no matches are hidden.
  const q = search.trim().toLowerCase();
  const visible = (people || [])
    .map(p => {
      if (!q) return { ...p, shownQuestions: p.questions };
      if (p.name.toLowerCase().includes(q)) return { ...p, shownQuestions: p.questions };
      const shownQuestions = p.questions.filter(x => x.question.toLowerCase().includes(q));
      return { ...p, shownQuestions };
    })
    .filter(p => p.shownQuestions.length > 0);

  return (
    <>
      <h1 style={{ fontSize: 24, fontWeight: 300, color: DESIGN_SHELL, letterSpacing: "0.01em", fontFamily: "Inter, Arial, sans-serif", marginBottom: 4 }}>
        Q&amp;A Log
      </h1>
      <p style={{ fontSize: 12, color: "#9a9088", letterSpacing: "0.04em", marginBottom: 20 }}>
        Vault questions asked by staff, most recent first. Re-asked questions appear once; questions a user has removed from their own history are not shown.
      </p>

      <input
        value={search}
        onChange={e => { setSearch(e.target.value); }}
        placeholder="Search questions or people…"
        style={{ width: 320, padding: "8px 12px", fontSize: 13, border: "1px solid #d8d0c5", background: "#fff", color: DESIGN_TEXT, fontFamily: "Inter, Arial, sans-serif", marginBottom: 20, display: "block" }}
      />

      {people === null && <p style={{ fontSize: 13, color: "#9a9088" }}>Loading…</p>}
      {error && <p style={{ fontSize: 13, color: "#9a9088" }}>Could not load the question log — please refresh.</p>}
      {people !== null && !error && visible.length === 0 && (
        <p style={{ fontSize: 13, color: "#9a9088" }}>{q ? "No questions match the search." : "No questions have been asked yet."}</p>
      )}

      {visible.map(p => {
        const isOpen = openPerson === p.userId;
        return (
          <div key={p.userId} style={{ border: "1px solid #e8e0d5", marginBottom: 8, background: "#fff" }}>
            <div onClick={() => setOpenPerson(isOpen ? null : p.userId)}
              style={{ display: "flex", alignItems: "center", gap: 14, padding: "11px 16px", cursor: "pointer", background: isOpen ? "#faf8f5" : "#fff" }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: DESIGN_TEXT }}>{p.name}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: VAULT_FULL, background: `${VAULT_FULL}18`, border: `1px solid ${VAULT_FULL}44`, padding: "2px 10px" }}>
                {p.shownQuestions.length}{q ? " matching" : ""} question{p.shownQuestions.length === 1 ? "" : "s"}
              </span>
              <span style={{ fontSize: 11, color: "#9a9088" }}>last asked {fmtDate(p.lastAsked)}</span>
              <span style={{ marginLeft: "auto", color: "#c0b8b0", fontSize: 13 }}>{isOpen ? "▲" : "▼"}</span>
            </div>

            {isOpen && p.shownQuestions.map((x, i) => (
              <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "8px 16px", borderTop: "1px solid #f2ede6" }}>
                <span style={{ fontSize: 11, color: "#9a9088", flexShrink: 0, minWidth: 130 }}>{fmtDate(x.askedAt)}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: VAULT_FULL, flexShrink: 0, minWidth: 110, overflowWrap: "anywhere" }}>{x.vaultName}</span>
                <span style={{ fontSize: 13, color: DESIGN_TEXT, overflowWrap: "anywhere" }}>{x.question}</span>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}
