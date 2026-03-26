import { useState, useRef, useCallback, useEffect } from "react";

const IS_DEMO = false;
const API_BASE = "https://vaultmind-production-5775.up.railway.app";
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const MAX_PAGES_PER_CHUNK = 90;

// ── API helpers ───────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `API error ${res.status}`);
  }
  return res.json();
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("Read failed"));
    r.readAsDataURL(file);
  });
}

async function splitPdfIntoChunks(base64Data, chunkSize) {
  try {
    if (!window.PDFLib) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    const { PDFDocument } = window.PDFLib;
    const pdfBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    const chunks = [];
    for (let start = 0; start < totalPages; start += chunkSize) {
      const end = Math.min(start + chunkSize, totalPages);
      const chunkDoc = await PDFDocument.create();
      const pages = await chunkDoc.copyPages(srcDoc, Array.from({ length: end - start }, (_, i) => start + i));
      pages.forEach(p => chunkDoc.addPage(p));
      const chunkBytes = await chunkDoc.save();
      const chunkBase64 = await new Promise((resolve) => {
        const blob = new Blob([chunkBytes], { type: "application/pdf" });
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.readAsDataURL(blob);
      });
      chunks.push({ base64: chunkBase64, startPage: start + 1, endPage: end, totalPages });
    }
    return chunks;
  } catch (e) {
    console.warn("PDF splitting failed:", e);
    return [{ base64: base64Data, startPage: 1, endPage: "?", totalPages: "?" }];
  }
}

async function callClaude(messages, systemPrompt, maxTokens = 1000, retries = 2, model = "gemini-2.5-flash") {
  const res = await fetch(`${API_BASE}/api/claude`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages }),
  });

  // Auto-retry on rate limit with 15 second wait (Gemini recovers faster)
  if (res.status === 429 && retries > 0) {
    console.log(`Rate limit hit, waiting 15 seconds before retry (${retries} retries left)…`);
    await new Promise(r => setTimeout(r, 15000));
    return callClaude(messages, systemPrompt, maxTokens, retries - 1, model);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `API error ${res.status}`);
  }
  const data = await res.json();
  return data.content.map(b => b.text || "").join("\n");
}

// ── sub-components ────────────────────────────────────────────────────────────

function Spinner({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
    </svg>
  );
}

function ProgressBar({ label, pct, color = "#1d70b8" }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#505a5f", marginBottom: 4 }}>
        <span style={{ fontWeight: 700 }}>{label}</span><span>{Math.round(pct)}%</span>
      </div>
      <div style={{ height: 5, background: "#b1b4b6" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, transition: "width 0.4s ease" }} />
      </div>
    </div>
  );
}

function formatInline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i} style={{ color: "#e8d5a3" }}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("`") && p.endsWith("`")) return <code key={i} style={{ background: "#1e1e1e", color: "#c8a96e", padding: "1px 5px", borderRadius: 3, fontSize: 12 }}>{p.slice(1, -1)}</code>;
    return p;
  });
}

// Approved Document green colour
const AD_GREEN = "#4a7c20";
const AD_GREEN_LIGHT = "#f0f4e8";
const AD_GREEN_MID = "#d4e6b5";

function AnswerRenderer({ text }) {
  if (!text) return null;
  const lines = text.split("\n");
  const elements = [];
  let tableBuffer = [];
  let inTable = false;

  const flushTable = (key) => {
    if (tableBuffer.length === 0) return;
    const rows = tableBuffer.map(r => r.split("|").map(c => c.trim()).filter(c => c !== ""));
    const header = rows[0];
    const body = rows.slice(2);
    elements.push(
      <div key={`tbl-${key}`} style={{ overflowX: "auto", margin: "16px 0", border: "1px solid #aaa" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr>{header.map((h, i) => (
              <th key={i} style={{ background: AD_GREEN, color: "#ffffff", padding: "8px 12px", border: "1px solid #777", textAlign: "left", fontWeight: 700, fontSize: 13, fontFamily: "Arial, sans-serif" }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri} style={{ background: ri % 2 === 0 ? "#ffffff" : AD_GREEN_LIGHT }}>
                {row.map((cell, ci) => (
                  <td key={ci} style={{ padding: "8px 12px", border: "1px solid #ccc", color: "#0b0c0c", verticalAlign: "top", fontSize: 13, lineHeight: 1.5 }}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    tableBuffer = []; inTable = false;
  };

  lines.forEach((line, i) => {
    if (line.startsWith("|")) { inTable = true; tableBuffer.push(line); return; }
    if (inTable) flushTable(i);

    if (line.startsWith("### ")) {
      // Sub-headings — green uppercase like AD section headings
      elements.push(
        <h3 key={i} style={{ color: AD_GREEN, fontSize: 13, fontWeight: 700, margin: "20px 0 6px", textTransform: "uppercase", letterSpacing: "0.04em", fontFamily: "Arial, sans-serif" }}>
          {line.slice(4)}
        </h3>
      );
    } else if (line.startsWith("## ")) {
      const text = line.slice(3);
      const isSummary = text.toLowerCase().includes("summary");
      if (isSummary) {
        // Summary — green requirement box style like D1 requirement box
        elements.push(
          <div key={i} style={{ background: AD_GREEN_LIGHT, border: `1px solid ${AD_GREEN_MID}`, borderLeft: `4px solid ${AD_GREEN}`, padding: "12px 16px", margin: "16px 0 8px" }}>
            <h2 style={{ color: AD_GREEN, fontSize: 15, fontWeight: 700, margin: 0, fontFamily: "Arial, sans-serif", textTransform: "uppercase", letterSpacing: "0.04em" }}>{text}</h2>
          </div>
        );
      } else {
        // Regular section heading — black with green underline rule
        elements.push(
          <div key={i} style={{ borderBottom: `2px solid ${AD_GREEN}`, marginTop: 28, marginBottom: 10, paddingBottom: 4 }}>
            <h2 style={{ color: "#0b0c0c", fontSize: 18, fontWeight: 700, margin: 0, fontFamily: "Arial, sans-serif" }}>{text}</h2>
          </div>
        );
      }
    } else if (line.startsWith("# ")) {
      elements.push(
        <div key={i} style={{ borderBottom: `3px solid ${AD_GREEN}`, marginTop: 32, marginBottom: 14, paddingBottom: 6 }}>
          <h1 style={{ color: "#0b0c0c", fontSize: 22, fontWeight: 700, margin: 0, fontFamily: "Arial, sans-serif" }}>{line.slice(2)}</h1>
        </div>
      );
    } else if (line.startsWith("> ")) {
      const quoteText = line.slice(2);
      const isCitation = quoteText.startsWith("*") && quoteText.endsWith("*");
      if (isCitation) {
        elements.push(
          <p key={i} style={{ fontSize: 12, color: "#555", fontStyle: "italic", margin: "3px 0 12px 16px", fontFamily: "Arial, sans-serif" }}>
            {quoteText.slice(1, -1)}
          </p>
        );
      } else {
        // Document quote — green left border, light green background like AD requirement boxes
        elements.push(
          <div key={i} style={{ borderLeft: `4px solid ${AD_GREEN}`, background: AD_GREEN_LIGHT, padding: "10px 14px", margin: "10px 0 4px", fontStyle: "italic", fontSize: 14, color: "#0b0c0c", lineHeight: 1.7, fontFamily: "Arial, sans-serif" }}>
            {quoteText}
          </div>
        );
      }
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(<li key={i} style={{ color: "#0b0c0c", fontSize: 14, lineHeight: 1.7, marginLeft: 20, marginBottom: 3, fontFamily: "Arial, sans-serif" }}>{formatInline(line.slice(2))}</li>);
    } else if (line.match(/^\d+\.\d+ /)) {
      // Numbered paragraphs like 1.1, 1.2 — AD style
      const numMatch = line.match(/^(\d+\.\d+) (.+)/);
      if (numMatch) {
        elements.push(
          <div key={i} style={{ display: "flex", gap: 12, margin: "6px 0", fontFamily: "Arial, sans-serif" }}>
            <span style={{ color: AD_GREEN, fontWeight: 700, fontSize: 14, flexShrink: 0, minWidth: 32 }}>{numMatch[1]}</span>
            <p style={{ color: "#0b0c0c", fontSize: 14, lineHeight: 1.7, margin: 0 }}>{formatInline(numMatch[2])}</p>
          </div>
        );
      }
    } else if (line.match(/^\d+\. /)) {
      elements.push(<li key={i} style={{ color: "#0b0c0c", fontSize: 14, lineHeight: 1.7, marginLeft: 20, marginBottom: 3, listStyleType: "decimal", fontFamily: "Arial, sans-serif" }}>{formatInline(line.replace(/^\d+\. /, ""))}</li>);
    } else if (line === "") {
      elements.push(<div key={i} style={{ height: 10 }} />);
    } else {
      elements.push(<p key={i} style={{ color: "#0b0c0c", fontSize: 14, lineHeight: 1.75, margin: "5px 0", fontFamily: "Arial, sans-serif" }}>{formatInline(line)}</p>);
    }
  });
  if (inTable) flushTable("end");
  return <div>{elements}</div>;
}

// ── main app ──────────────────────────────────────────────────────────────────

export default function App() {
  const [vaults, setVaults] = useState([]);
  const [selectedVault, setSelectedVault] = useState(null);
  const [pdfs, setPdfs] = useState([]);
  const [vaultIndex, setVaultIndex] = useState(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState(null);
  const [stage, setStage] = useState(null);
  const [progress, setProgress] = useState({ index: 0, select: 0, read: 0, answer: 0 });
  const [statusMsg, setStatusMsg] = useState("");
  const [creating, setCreating] = useState(false);
  const [newVaultName, setNewVaultName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [costEst, setCostEst] = useState(null);
  const [history, setHistory] = useState([]);
  const [loadingVaults, setLoadingVaults] = useState(true);
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const fileInputRef = useRef();

  const vault = vaults.find(v => v.id === selectedVault);
  const vaultHistory = history.filter(h => h.vaultId === selectedVault);

  // ── load vaults on mount ────────────────────────────────────────────────────
  useEffect(() => {
    loadVaults();
  }, []);

  const loadVaults = async () => {
    setLoadingVaults(true);
    try {
      const data = await api("/api/vaults");
      setVaults(data.vaults || []);
    } catch (e) {
      console.error("Failed to load vaults:", e);
    }
    setLoadingVaults(false);
  };

  // ── load PDFs and index when vault selected ─────────────────────────────────
  useEffect(() => {
    if (!selectedVault) return;
    loadVaultContents(selectedVault);
  }, [selectedVault]);

  const loadVaultContents = async (vaultId) => {
    setAnswer(null);
    setStage(null);
    setStatusMsg("Loading vault…");
    setPdfs([]);
    setVaultIndex(null);

    try {
      const [pdfsData, indexData] = await Promise.all([
        api(`/api/vaults/${vaultId}/pdfs`),
        api(`/api/vaults/${vaultId}/index`).catch(() => null),
      ]);
      setPdfs(pdfsData.pdfs || []);
      setVaultIndex(indexData);
      if (indexData) {
        const total = (indexData.documents || []).reduce((s, d) => s + (d.headings?.length || 0), 0);
        setStatusMsg(`✓ Vault ready — ${total} sections indexed across ${pdfsData.pdfs.length} document${pdfsData.pdfs.length !== 1 ? "s" : ""}.`);
      } else {
        setStatusMsg(pdfsData.pdfs.length > 0 ? "Documents loaded — click Index Vault to prepare for questions." : "No documents yet — upload PDFs to get started.");
      }
    } catch (e) {
      setStatusMsg("Error loading vault: " + e.message);
    }
  };

  // ── vault creation ──────────────────────────────────────────────────────────
  const createVault = async () => {
    if (!newVaultName.trim()) return;
    try {
      const v = await api("/api/vaults", { method: "POST", body: { name: newVaultName.trim() } });
      setVaults(prev => [...prev, v]);
      setSelectedVault(v.id);
      setNewVaultName("");
      setCreating(false);
    } catch (e) {
      alert("Failed to create vault: " + e.message);
    }
  };

  // ── PDF upload ──────────────────────────────────────────────────────────────
  const addPDFs = useCallback(async (files) => {
    if (!vault) return;
    const pdfFiles = Array.from(files).filter(f => f.type === "application/pdf");
    if (!pdfFiles.length) return;
    setUploadingPdf(true);
    for (const file of pdfFiles) {
      setStatusMsg(`Uploading ${file.name}…`);
      try {
        const base64 = await fileToBase64(file);
        await api(`/api/vaults/${vault.id}/pdfs`, { method: "POST", body: { name: file.name, base64 } });
      } catch (e) {
        console.error("Upload failed:", e);
        setStatusMsg(`Failed to upload ${file.name}: ${e.message}`);
      }
    }
    setUploadingPdf(false);
    await loadVaultContents(vault.id);
    setVaultIndex(null); // index is now stale
    setStatusMsg("Upload complete — click Index Vault to update the index.");
  }, [vault]);

  const onDrop = (e) => { e.preventDefault(); setDragOver(false); addPDFs(e.dataTransfer.files); };

  const deletePdf = async (pdf) => {
    if (!window.confirm(`Remove "${pdf.name}" from this vault? This cannot be undone.`)) return;
    try {
      await api(`/api/vaults/${encodeURIComponent(vault.id)}/pdfs/${encodeURIComponent(pdf.name)}`, { method: "DELETE" });
      setVaultIndex(null); // index is now stale
      await loadVaultContents(vault.id);
      setStatusMsg(`"${pdf.name}" removed — re-index the vault to update.`);
    } catch (e) {
      setStatusMsg("Failed to remove: " + e.message);
    }
  };

  // ── indexing ────────────────────────────────────────────────────────────────
  const indexVault = async () => {
    if (!vault || pdfs.length === 0) return;
    setStage("indexing");
    setProgress({ index: 0, select: 0, read: 0, answer: 0 });
    setStatusMsg("Loading documents for indexing…");
    setAnswer(null);

    try {
      const allDocuments = [];

      for (let i = 0; i < pdfs.length; i++) {
        const pdf = pdfs[i];
        setStatusMsg(`Fetching document ${i + 1} of ${pdfs.length}: ${pdf.name}…`);

        // Load PDF from R2
        const pdfData = await api(`/api/vaults/${vault.id}/pdfs/${encodeURIComponent(pdf.name)}`);
        const base64 = pdfData.base64;

        setStatusMsg(`Scanning ${pdf.name}…`);
        setProgress(p => ({ ...p, index: Math.round((i / pdfs.length) * 80) }));

        let docIndex = { name: pdf.name, headings: [] };
        try {
          // Send full PDF directly to Gemini — no client-side splitting needed.
          // Gemini 2.5 has a 1M token context window so chunking is unnecessary,
          // and browser pdf-lib crashes on GOV.UK encrypted PDFs anyway.
          const contentBlocks = [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 }, title: pdf.name },
            { type: "text", text: 'Extract ALL structural metadata from this document: every section heading, sub-heading, chapter name, table of contents entry, figure and table caption. Output ONLY valid JSON: {"headings": [{"level": 1, "title": "heading text", "pageHint": 1}]}' }
          ];

          try {
            const indexText = await callClaude(
              [{ role: "user", content: contentBlocks }],
              "You are a document indexer. Extract only structural metadata. Return pure JSON only, no markdown, no explanation.",
              65000,
              2,
              "gemini-2.5-flash-lite"
            );
            console.log(`Raw index response for ${pdf.name} (first 200 chars):`, indexText.slice(0, 200));
            let parsed = null;
            const clean = indexText.replace(/```json|```/g, "").trim();
            try { parsed = JSON.parse(clean); } catch (e) { console.warn("JSON.parse failed:", e.message); }
            if (!parsed) { const m = clean.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch {} }
            if (!parsed) { const m = clean.match(/"headings"\s*:\s*(\[[\s\S]*?\])/); if (m) try { parsed = { headings: JSON.parse(m[1]) }; } catch {} }
            console.log("Parsed result:", parsed ? `${parsed.headings?.length} headings` : "null");
            if (parsed?.headings) docIndex = { name: pdf.name, headings: parsed.headings };
            console.log(`Indexed ${pdf.name}: ${docIndex.headings.length} headings found`);
          } catch (e) {
            console.warn(`Indexing ${pdf.name} failed:`, e);
          }
        } catch (e) {
          console.warn(`Could not index ${pdf.name}:`, e);
        }
        allDocuments.push(docIndex);
      }

      setProgress(p => ({ ...p, index: 100 }));

      const indexData = { documents: allDocuments, indexedAt: new Date().toISOString() };

      // Save index permanently to R2
      setStatusMsg("Saving index…");
      await api(`/api/vaults/${vault.id}/index`, { method: "POST", body: indexData });

      setVaultIndex(indexData);
      setStage("done-index");
      const totalHeadings = allDocuments.reduce((s, d) => s + (d.headings?.length || 0), 0);
      setStatusMsg(`✓ Vault indexed — ${totalHeadings} sections mapped across ${allDocuments.length} document${allDocuments.length !== 1 ? "s" : ""}. Ready for questions.`);
    } catch (err) {
      setStage(null);
      setStatusMsg("Indexing failed: " + err.message);
    }
  };

  // ── single document re-index ────────────────────────────────────────────────
  const indexSinglePdf = async (pdf) => {
    if (!vault) return;
    setStage("indexing");
    setStatusMsg(`Re-indexing ${pdf.name}…`);
    setAnswer(null);
    try {
      const pdfData = await api(`/api/vaults/${vault.id}/pdfs/${encodeURIComponent(pdf.name)}`);
      const base64 = pdfData.base64;
      const contentBlocks = [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 }, title: pdf.name },
        { type: "text", text: 'Extract ALL structural metadata from this document: every section heading, sub-heading, chapter name, table of contents entry, figure and table caption. Output ONLY valid JSON: {"headings": [{"level": 1, "title": "heading text", "pageHint": 1}]}' }
      ];
      const indexText = await callClaude(
        [{ role: "user", content: contentBlocks }],
        "You are a document indexer. Extract only structural metadata. Return pure JSON only, no markdown, no explanation.",
        65000,
        2,
        "gemini-2.5-flash-lite"
      );
      let parsed = null;
      const clean = indexText.replace(/```json|```/g, "").trim();
      try { parsed = JSON.parse(clean); } catch {}
      if (!parsed) { const m = clean.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch {} }
      if (!parsed?.headings) throw new Error("Could not parse index response");

      // Merge with existing index — replace this doc's entry
      const existingDocs = (vaultIndex?.documents || []).filter(d => d.name !== pdf.name);
      const newDocIndex = { name: pdf.name, headings: parsed.headings };
      const newIndex = { documents: [...existingDocs, newDocIndex], indexedAt: new Date().toISOString() };

      await api(`/api/vaults/${vault.id}/index`, { method: "POST", body: newIndex });
      setVaultIndex(newIndex);
      setStage("done-index");
      const total = newIndex.documents.reduce((s, d) => s + (d.headings?.length || 0), 0);
      setStatusMsg(`✓ ${pdf.name} re-indexed — ${parsed.headings.length} sections found. ${total} total sections across vault.`);
    } catch (e) {
      setStage(null);
      setStatusMsg(`Re-index failed for ${pdf.name}: ${e.message}`);
    }
  };

  // ── question answering — 3-pass pipeline ────────────────────────────────────
  const askQuestion = async () => {
    if (!vaultIndex || !question.trim()) return;
    const q = question.trim();
    setAnswer(null);
    setCostEst(null);
    setQuestion("");
    setStage("selecting");
    setProgress({ index: 100, select: 0, read: 0, answer: 0 });
    setStatusMsg("Pass 1/3 · Reading contents pages and scoring sections…");

    try {
      // ── PASS 1: Score index only — NO PDFs sent, pure text, very cheap ────────
      setStatusMsg("Pass 1/3 · Scoring index — identifying relevant sections…");

      // Compress index into compact plain text — far more efficient than raw JSON
      // Format: "DOCUMENT: filename\n  p14: Section heading\n  p22: Another section"
      // This reduces token usage by ~70% vs JSON, allowing 20+ documents to fit
      const indexSummary = (vaultIndex.documents || []).map(doc => {
        const headings = (doc.headings || [])
          .map(h => `  p${h.pageHint || 1}: ${h.title}`)
          .join("\n");
        return `DOCUMENT: ${doc.name}\n${headings}`;
      }).join("\n\n");
      setProgress(p => ({ ...p, select: 30 }));

      const scoringPrompt = `You are an expert building regulations analyst. Using ONLY the document index below, identify which specific sections and pages are most likely to contain the answer to the question.

DOCUMENT INDEX (headings, sections and page numbers extracted from vault documents):
${indexSummary}

QUESTION: ${q}

Analyse the index carefully. For every section that could possibly be relevant — even tangentially — assign a probability score. Building regulations frequently contain cross-references, exceptions and caveats in unexpected sections. Be CONSERVATIVE — it is better to include a borderline section than to miss critical information.

Respond ONLY as JSON — no other text:
{
  "styleNotes": "brief description of document style and terminology",
  "selectedDocs": [
    {
      "docName": "exact document filename as it appears in the index",
      "reason": "why this document is relevant",
      "sections": [
        {
          "heading": "exact section heading from index",
          "pageHint": 42,
          "probability": 0.95,
          "reason": "why this section is relevant",
          "crossRefs": ["other section headings this likely cross-references"]
        }
      ]
    }
  ]
}

Include ALL sections with probability > 0.3. Always include page numbers where available in the index.
IMPORTANT: pageHint MUST be a plain integer (e.g. 42) or a range string (e.g. "12-15"). Never use text like "p.12" or "page 12". If no page number is known, use 1.`;

      const scoringText = await callClaude(
        [{ role: "user", content: scoringPrompt }],
        "You are a building regulations expert. Score document sections for relevance using only the text index provided. Return pure JSON only, no markdown.",
        8000,
        2,
        "gemini-2.5-flash-lite"
      );

      setProgress(p => ({ ...p, select: 100 }));

      let scoring = { selectedDocs: [], styleNotes: "" };
      try {
        const clean = scoringText.replace(/```json|```/g, "").trim();
        scoring = JSON.parse(clean);
      } catch {
        const m = scoringText.match(/\{[\s\S]*\}/);
        if (m) try { scoring = JSON.parse(m[0]); } catch {}
      }
      // If scoring came back empty, log the raw response for debugging
      if (!scoring.selectedDocs || scoring.selectedDocs.length === 0) {
        console.warn("Scoring returned empty — raw response:", scoringText.slice(0, 500));
      }
      // Debug: log scoring result
      console.log("Scoring result:", JSON.stringify(scoring).slice(0, 500));
      console.log("Selected docs:", (scoring.selectedDocs || []).length);
      (scoring.selectedDocs || []).forEach(d => {
        console.log("Doc:", d.docName, "Sections:", (d.sections || []).length);
        (d.sections || []).slice(0, 3).forEach(s => {
          console.log("  Section:", s.heading?.slice(0,30), "pageHint:", JSON.stringify(s.pageHint), typeof s.pageHint);
        });
      });

      // Pre-load all PDFs needed for page extraction (done after scoring, not before)
      setStatusMsg("Pass 1/3 · Loading documents for page extraction…");
      const contentsData = [];
      const selectedDocNames = (scoring.selectedDocs || []).map(d => d.docName);
      const docsNeeded = pdfs.filter(p =>
        selectedDocNames.some(n => p.name.includes(n) || n.includes(p.name))
      );
      const docsToFetch = docsNeeded.length > 0 ? docsNeeded : pdfs.slice(0, 2);

      for (const pdf of docsToFetch) {
        try {
          const pdfData = await api(`/api/vaults/${encodeURIComponent(vault.id)}/pdfs/${encodeURIComponent(pdf.name)}`);
          contentsData.push({ pdf, base64: pdfData.base64 });
        } catch (e) {
          console.warn(`Could not load ${pdf.name}:`, e);
        }
      }

      // ── PASS 2: Extract ONLY the specific pages identified in Pass 1 ─────────
      setStage("reading");
      setStatusMsg("Pass 2/3 · Extracting specific relevant pages only…");

      // Helper to parse page hints in ANY format — very aggressive extraction
      const parsePageNums = (hint) => {
        const pages = new Set();
        if (hint === null || hint === undefined) return pages;

        // Handle plain numbers directly (most common case after prompt fix)
        if (typeof hint === "number") {
          if (hint > 0 && hint < 9999) pages.add(Math.round(hint));
          return pages;
        }

        const str = String(hint).trim();
        if (!str) return pages;

        // Try direct integer parse first
        const directInt = parseInt(str);
        if (!isNaN(directInt) && directInt > 0 && directInt < 9999) {
          pages.add(directInt);
          return pages;
        }

        // Extract all numbers from the string
        const allNums = str.match(/\d+/g);
        if (!allNums) return pages;

        const nums = allNums.map(n => parseInt(n)).filter(n => n > 0 && n < 9999);
        if (nums.length === 0) return pages;

        // Two close numbers = range
        if (nums.length >= 2 && nums[1] > nums[0] && nums[1] <= nums[0] + 30) {
          for (let i = nums[0]; i <= nums[1]; i++) pages.add(i);
          return pages;
        }

        // Otherwise each number is a page
        nums.forEach(n => pages.add(n));
        return pages;
      };

      // Build a ranked list of all sections across all docs, sorted by probability (highest first)
      // This ensures the 90-page budget is spent on the MOST relevant pages first
      const HARD_PAGE_BUDGET = 50;
      const allScoredSections = [];

      (scoring.selectedDocs || []).forEach(selectedDoc => {
        const matchedDoc = contentsData.find(d =>
          d.pdf.name.includes(selectedDoc.docName) || selectedDoc.docName.includes(d.pdf.name)
        );
        if (!matchedDoc) return;
        (selectedDoc.sections || []).forEach(section => {
          const parsed = parsePageNums(section.pageHint);
          if (parsed.size > 0) {
            allScoredSections.push({
              docName: matchedDoc.pdf.name,
              contentsDoc: matchedDoc,
              pages: parsed,
              probability: section.probability || 0,
              heading: section.heading,
            });
          }
        });
      });

      // Sort by probability descending — highest relevance first
      allScoredSections.sort((a, b) => b.probability - a.probability);

      // Fill page budget from highest probability sections downward
      const docPageMap = {};
      let budgetRemaining = HARD_PAGE_BUDGET;

      for (const section of allScoredSections) {
        if (budgetRemaining <= 0) break;

        const key = section.docName;
        if (!docPageMap[key]) docPageMap[key] = { contentsDoc: section.contentsDoc, pages: new Set() };

        // Add pages — no buffer, every page counts with tight budget
        const pagesToAdd = [];
        section.pages.forEach(p => {
          if (!docPageMap[key].pages.has(p)) pagesToAdd.push(p);
        });

        // Only add pages if we have budget remaining
        for (const p of pagesToAdd) {
          if (budgetRemaining <= 0) break;
          docPageMap[key].pages.add(p);
          budgetRemaining--;
        }
      }

      // Fallback 1: if no docs matched at all, use first 5 pages of top 2 docs
      if (Object.keys(docPageMap).length === 0 && contentsData.length > 0) {
        contentsData.slice(0, 2).forEach(d => {
          docPageMap[d.pdf.name] = { contentsDoc: d, pages: new Set() };
          for (let i = 1; i <= 5; i++) docPageMap[d.pdf.name].pages.add(i);
        });
      }

      // Fallback 2: if docs matched but pages are empty (page hint parsing failed), use first 5 pages
      Object.entries(docPageMap).forEach(([key, val]) => {
        if (val.pages.size === 0) {
          for (let i = 1; i <= 5; i++) val.pages.add(i);
        }
      });

      const pagesUsed = HARD_PAGE_BUDGET - budgetRemaining;
      console.log(`Page budget used: ${pagesUsed}/${HARD_PAGE_BUDGET} pages across ${Object.keys(docPageMap).length} documents`);
      if (pagesUsed === 0) {
        console.warn("WARNING: No pages selected — page hint format may not be parseable");
        // Log what page hints look like for debugging
        (scoring.selectedDocs || []).forEach(d => {
          (d.sections || []).forEach(s => {
            console.log("pageHint sample:", JSON.stringify(s.pageHint), "heading:", s.heading?.slice(0,40));
          });
        });
      }

      // Extract specific pages server-side (reliable binary handling)
      const docBlocks = [];
      let totalPagesExtracted = 0;

      for (const [docName, { contentsDoc, pages }] of Object.entries(docPageMap)) {
        setStatusMsg(`Pass 2/3 · Extracting pages from ${docName}…`);
        const pageList = Array.from(pages).sort((a, b) => a - b);
        if (pageList.length === 0) continue;

        try {
          // Try server-side page extraction first
          const result = await api("/api/extract-pages", {
            method: "POST",
            body: { base64: contentsDoc.base64, pages: pageList }
          });
          totalPagesExtracted += result.pagesExtracted;
          docBlocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: result.base64 },
            title: `${docName} — pages ${result.pageNumbers.join(", ")}`,
          });
          console.log(`Extracted ${result.pagesExtracted} pages from ${docName}`);
        } catch (e) {
          // Page extraction failed — skip this document rather than sending full PDF
          // Full PDFs would be too large and slow to send to Gemini
          console.warn(`Page extraction failed for ${docName}, skipping:`, e.message);
        }
      }

      setStatusMsg(`Pass 2/3 · ${totalPagesExtracted} specific pages extracted across ${docBlocks.length} document${docBlocks.length !== 1 ? "s" : ""}…`);
      setProgress(p => ({ ...p, read: 100 }));

      // ── PASS 3: Deep read extracted pages + answer ─────────────────────────
      setStage("answering");
      setStatusMsg("Pass 3/3 · Deep reading selected pages and synthesising answer…");

      const vaultDocNames = pdfs.map(p => p.name).join(", ");
      const focusSections = (scoring.selectedDocs || [])
        .flatMap(d => (d.sections || []).map(s => `${d.docName}: ${s.heading} (p.${s.pageHint})`))
        .join("; ");

      const answerPrompt = `You are an expert building regulations consultant at an architectural practice answering a specific technical question. Use ONLY the provided document pages.

VAULT: ${vault.name}
QUESTION: ${q}
PRIORITY SECTIONS IDENTIFIED: ${focusSections || "all sections"}

---

INSTRUCTIONS:

Step 1 — Read all provided document pages carefully and identify every passage directly relevant to the question.
Step 2 — Build the Detailed Analysis from that evidence.
Step 3 — Write the Summary as a confident, definitive conclusion drawn from that analysis.

---

## Detailed Analysis

Organise by document. For each relevant section:

1. One plain English sentence introducing what this section establishes and why it is relevant to the question
2. The exact quoted passage from the document as a block quote
3. The citation on its own line immediately below

QUOTE FORMAT:
> "[Exact text from document — do not paraphrase or truncate]"

CITATION FORMAT (own line below quote):
> *[Document Name] | Page [X] | Section [X.X] — [Heading]*

Use ### sub-headings matching source document section headings.
Use **bold** for regulation numbers, defined terms, and critical requirements.
Only include sections that directly answer the question — omit anything tangential.

---

## Summary

A confident, definitive answer in 2–4 sentences. This must:
- State the answer directly and definitively — do not hedge unless there is genuine ambiguity in the documents
- Explain the reasoning in one sentence referencing the key evidence
- Include a table if the answer involves dimensions, measurements or comparative requirements

TABLE FORMAT:
| Type | Requirement | Value | Source |
|---|---|---|---|

CITATION FORMAT — inline after each statement:
*[Document Name] | Page [X] | Section [X.X]*

---

## Contradictions & Conflicts

If conflicts exist between documents: state the conflict in one sentence, quote both sides with citations, then give a definitive practical conclusion on which takes precedence and why.

If no conflicts: write "No contradictions identified."

---

RULES:
- Use ONLY the provided document pages — no external knowledge
- Every factual statement must have a citation
- If a page number or section reference is unclear from the document, omit the citation rather than guess
- If the provided pages do not contain enough information to answer definitively, state exactly what is missing and why`;

      const finalAnswer = await callClaude(
        [{ role: "user", content: [...docBlocks, { type: "text", text: answerPrompt }] }],
        `You are an expert building regulations consultant at an architectural practice. Answer using ONLY the provided document pages. Give definitive answers. Structure: (1) Detailed Analysis with exact quotes and citations, (2) Summary as a confident conclusion with table if relevant, (3) Contradictions with practical resolution. Never hedge unless genuine ambiguity exists in the documents.`,
        65536
      );

      setProgress(p => ({ ...p, answer: 100 }));
      setAnswer(finalAnswer);
      setStage("done");
      setHistory(prev => [...prev, { vaultId: vault.id, question: q, answer: finalAnswer, timestamp: new Date() }]);

      const estimatedTokens = (indexSummary.length + answerPrompt.length + totalPagesExtracted * 500) / 4;
      const costGBP = (estimatedTokens / 1_000_000) * 3 * 0.79;
      setCostEst(costGBP);
      setStatusMsg(`Answer ready · Est. cost: ${costGBP < 0.01 ? "< 1p" : costGBP.toFixed(2) + "p"}`);
    } catch (err) {
      setStage(null);
      if (err.message && err.message.includes('rate_limit')) {
        setStatusMsg('Rate limit reached — retrying automatically in 15 seconds…');
      } else {
        setStatusMsg("Error: " + err.message);
      }
    }
  };

  const isRunning = ["indexing", "selecting", "reading", "answering"].includes(stage);

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: "Arial, sans-serif", background: "#f3f2f1", minHeight: "100vh", color: "#0b0c0c", display: "flex", flexDirection: "column" }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: #f3f2f1; } ::-webkit-scrollbar-thumb { background: #b1b4b6; border-radius: 3px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .vault-item { cursor: pointer; transition: background 0.15s; }
        .vault-item:hover { background: #e8f0fe !important; }
        .btn { cursor: pointer; transition: all 0.15s; border: none; font-family: Arial, sans-serif; }
        .btn:hover { filter: brightness(0.92); }
        .btn:disabled { cursor: not-allowed; opacity: 0.4; }
        .govuk-input:focus { outline: 3px solid #ffdd00; outline-offset: 0; }
      `}</style>

      {/* HM Government crown bar — matches Approved Document header */}
      <div style={{ background: "#0b0c0c", padding: "8px 20px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <span style={{ color: "#ffffff", fontSize: 13, fontWeight: 700 }}>🏛</span>
        <span style={{ color: "#ffffff", fontSize: 13, fontWeight: 700 }}>HM Government</span>
        <span style={{ color: "#555", fontSize: 12, marginLeft: 8 }}>|</span>
        <span style={{ color: "#aaa", fontSize: 12 }}>Building Regulations — Approved Documents</span>
      </div>

      {/* Green service header — matches AD green */}
      <div style={{ background: "#4a7c20", padding: "14px 20px", flexShrink: 0, display: "flex", alignItems: "baseline", gap: 16 }}>
        <span style={{ color: "#ffffff", fontSize: 20, fontWeight: 700, fontFamily: "Arial, sans-serif" }}>VaultMind</span>
        <span style={{ color: "#d4e6b5", fontSize: 14, fontFamily: "Arial, sans-serif" }}>Approved Document Intelligence</span>
      </div>

      <div style={{ flex: 1, display: "flex", overflow: "hidden", maxHeight: "calc(100vh - 89px)" }}>

        {/* sidebar */}
        <div style={{ width: 280, borderRight: "1px solid #b1b4b6", background: "#ffffff", display: "flex", flexDirection: "column", flexShrink: 0 }}>

          {/* Vault list */}
          <div style={{ padding: "14px 16px 6px", fontSize: 11, color: "#505a5f", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid #f3f2f1" }}>Document Vaults</div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {loadingVaults ? (
              <div style={{ padding: 16, display: "flex", alignItems: "center", gap: 8, color: "#505a5f", fontSize: 13 }}><Spinner size={12} /> Loading…</div>
            ) : vaults.map(v => (
              <div key={v.id} className="vault-item"
                onClick={() => { setSelectedVault(v.id); setAnswer(null); setStage(null); setCostEst(null); }}
                style={{ padding: "10px 16px", background: selectedVault === v.id ? "#f0f4e8" : "transparent", borderLeft: selectedVault === v.id ? "4px solid #4a7c20" : "4px solid transparent" }}>
                <div style={{ fontSize: 14, color: "#0b0c0c", fontWeight: selectedVault === v.id ? 700 : 400 }}>{v.name}</div>
              </div>
            ))}
          </div>

          {creating ? (
            <div style={{ padding: "12px 16px", borderTop: "1px solid #b1b4b6", background: "#f3f2f1" }}>
              <label style={{ fontSize: 13, fontWeight: 700, color: "#0b0c0c", display: "block", marginBottom: 4 }}>Vault name</label>
              <input value={newVaultName} onChange={e => setNewVaultName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && createVault()}
                placeholder="Enter vault name" autoFocus className="govuk-input"
                style={{ width: "100%", border: "2px solid #0b0c0c", padding: "6px 8px", fontSize: 14, color: "#0b0c0c", marginBottom: 8, outline: "none" }} />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" onClick={createVault} style={{ background: "#00703c", color: "#ffffff", padding: "7px 14px", fontSize: 14, fontWeight: 700 }}>Create</button>
                <button className="btn" onClick={() => setCreating(false)} style={{ background: "#f3f2f1", color: "#0b0c0c", padding: "7px 14px", fontSize: 14, border: "1px solid #0b0c0c" }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ padding: "12px 16px", borderTop: "1px solid #b1b4b6" }}>
              <button className="btn" onClick={() => setCreating(true)}
                style={{ width: "100%", background: "#4a7c20", color: "#ffffff", padding: "9px 0", fontSize: 14, fontWeight: 700, textAlign: "center" }}>
                + New Vault
              </button>
            </div>
          )}
        </div>

        {/* main */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "#f3f2f1" }}>
          {!vault ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
              <p style={{ fontSize: 18, color: "#505a5f", fontWeight: 700 }}>Select or create a vault</p>
              <p style={{ fontSize: 14, color: "#6f777b" }}>Upload PDFs once — available to your whole team instantly</p>
            </div>
          ) : (
            <>
              {/* Vault header */}
              <div style={{ padding: "16px 24px", borderBottom: "3px solid #4a7c20", background: "#ffffff", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
                <div>
                  <h1 style={{ fontSize: 22, fontWeight: 700, color: "#0b0c0c" }}>{vault.name}</h1>
                  <p style={{ fontSize: 13, color: "#505a5f", marginTop: 2 }}>
                    {pdfs.length} document{pdfs.length !== 1 ? "s" : ""} &nbsp;·&nbsp;
                    {vaultIndex
                      ? <span style={{ color: "#4a7c20", fontWeight: 700 }}>✓ Indexed</span>
                      : <span style={{ color: "#d4351c" }}>Not indexed</span>}
                  </p>
                </div>
                {pdfs.length > 0 && (
                  <button className="btn" onClick={indexVault} disabled={isRunning}
                    style={{ background: vaultIndex ? "#f3f2f1" : "#4a7c20", color: vaultIndex ? "#0b0c0c" : "#ffffff", border: vaultIndex ? "1px solid #b1b4b6" : "none", padding: "9px 20px", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
                    {stage === "indexing" ? <><Spinner size={13} /> Indexing…</> : vaultIndex ? "Re-index Vault" : "Index Vault"}
                  </button>
                )}
              </div>

              <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

                {/* PDF panel */}
                <div style={{ width: 240, borderRight: "1px solid #b1b4b6", background: "#ffffff", display: "flex", flexDirection: "column", flexShrink: 0 }}>
                  <div onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
                    onClick={() => fileInputRef.current.click()}
                    style={{ margin: 12, border: `2px dashed ${dragOver ? "#4a7c20" : "#b1b4b6"}`, padding: "14px 10px", textAlign: "center", cursor: "pointer", background: dragOver ? "#f0f4e8" : "#f3f2f1" }}>
                    {uploadingPdf ? (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "#1d70b8", fontSize: 13 }}><Spinner size={14} /> Uploading…</div>
                    ) : (
                      <>
                        <div style={{ fontSize: 22, marginBottom: 4 }}>📄</div>
                        <p style={{ fontSize: 12, color: "#505a5f", lineHeight: 1.5 }}>Drop PDFs here<br />or click to browse</p>
                      </>
                    )}
                    <input ref={fileInputRef} type="file" multiple accept="application/pdf" style={{ display: "none" }} onChange={e => addPDFs(e.target.files)} />
                  </div>

                  <div style={{ flex: 1, overflowY: "auto" }}>
                    {pdfs.length > 0 && (
                      <div style={{ padding: "4px 12px 2px", fontSize: 10, color: "#505a5f", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", display: "flex", gap: 12 }}>
                        <span style={{ color: "#00703c" }}>✓ indexed</span>
                        <span style={{ color: "#6f777b" }}>○ not indexed</span>
                      </div>
                    )}
                    {pdfs.map(pdf => {
                      const isIndexed = vaultIndex?.documents?.some(d => d.name === pdf.name);
                      return (
                        <div key={pdf.id} style={{ padding: "7px 12px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #f3f2f1" }}>
                          <span style={{ fontSize: 10, color: isIndexed ? "#00703c" : "#6f777b", flexShrink: 0, fontWeight: 700 }}>{isIndexed ? "✓" : "○"}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, color: "#0b0c0c", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pdf.name}</div>
                            <div style={{ fontSize: 10, color: "#6f777b", marginTop: 1 }}>{(pdf.size / 1024).toFixed(0)} KB</div>
                          </div>
                          <button className="btn" onClick={() => indexSinglePdf(pdf)} disabled={isRunning} title="Re-index this document"
                            style={{ background: "none", color: "#6f777b", fontSize: 11, padding: "2px 4px", lineHeight: 1, flexShrink: 0, fontWeight: 700 }}
                            onMouseEnter={e => e.target.style.color = "#4a7c20"}
                            onMouseLeave={e => e.target.style.color = "#6f777b"}>↻</button>
                          <button className="btn" onClick={() => deletePdf(pdf)} disabled={isRunning} title="Remove"
                            style={{ background: "none", color: "#6f777b", fontSize: 15, padding: "2px 4px", lineHeight: 1, flexShrink: 0, fontWeight: 700 }}
                            onMouseEnter={e => e.target.style.color = "#d4351c"}
                            onMouseLeave={e => e.target.style.color = "#6f777b"}>×</button>
                        </div>
                      );
                    })}
                    {pdfs.length === 0 && <p style={{ fontSize: 13, color: "#6f777b", textAlign: "center", marginTop: 20 }}>No documents yet</p>}
                  </div>
                </div>

                {/* Q&A panel */}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

                  {/* Progress */}
                  {isRunning && (
                    <div style={{ padding: "14px 24px", borderBottom: "1px solid #b1b4b6", background: "#ffffff", flexShrink: 0, animation: "fadeIn 0.3s ease" }}>
                      <div style={{ fontSize: 13, color: "#4a7c20", marginBottom: 10, display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}><Spinner size={13} /> {statusMsg}</div>
                      <ProgressBar label="Pass 1 · Index scoring" pct={progress.select} color="#4a7c20" />
                      <ProgressBar label="Pass 2 · Page extraction" pct={progress.read} color="#00703c" />
                      <ProgressBar label="Pass 3 · Answer synthesis" pct={progress.answer} color="#4c2c92" />
                    </div>
                  )}

                  {/* Status bar */}
                  {!isRunning && statusMsg && (
                    <div style={{ padding: "8px 24px", borderBottom: "1px solid #b1b4b6", background: "#ffffff", fontSize: 13, color: "#505a5f", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
                      <span>{statusMsg}</span>
                      {costEst !== null && (
                        <span style={{ background: costEst < 0.01 ? "#e9f7ef" : "#fff7e6", border: `1px solid ${costEst < 0.01 ? "#00703c" : "#f47738"}`, color: costEst < 0.01 ? "#00703c" : "#f47738", padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>
                          {costEst < 0.01 ? "✓ Under 1p" : `~${(costEst * 100).toFixed(2)}p`}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Answer area */}
                  <div style={{ flex: 1, overflowY: "auto", padding: "20px 28px" }}>

                    {/* History */}
                    {vaultHistory.length > 0 && (
                      <div style={{ marginBottom: 20 }}>
                        {vaultHistory.map((h, i) => (
                          <div key={i} style={{ marginBottom: 8 }}>
                            <div style={{ fontSize: 13, color: "#505a5f", background: "#ffffff", border: "1px solid #b1b4b6", padding: "8px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                              <span style={{ color: "#4a7c20", fontWeight: 700, flexShrink: 0 }}>Q:</span>
                              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.question}</span>
                              <span style={{ fontSize: 11, color: "#6f777b", flexShrink: 0 }}>{new Date(h.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Current answer */}
                    {answer && (
                      <div style={{ animation: "fadeIn 0.4s ease" }}>
                        <div style={{ background: "#ffffff", border: "1px solid #b1b4b6", borderTop: "4px solid #4a7c20", padding: "24px 28px" }}>
                          <p style={{ fontSize: 12, color: "#505a5f", marginBottom: 16, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            Response — {vault.name}
                          </p>
                          <AnswerRenderer text={answer} />
                        </div>
                      </div>
                    )}

                    {!answer && !isRunning && vaultIndex && vaultHistory.length === 0 && (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12 }}>
                        <div style={{ width: 48, height: 5, background: "#4a7c20" }} />
                        <p style={{ fontSize: 18, color: "#505a5f", fontWeight: 700 }}>Ask a question about this vault</p>
                        <p style={{ fontSize: 14, color: "#6f777b" }}>The AI selects the most relevant pages before answering</p>
                      </div>
                    )}

                    {!vaultIndex && !isRunning && pdfs.length > 0 && (
                      <div style={{ background: "#fff7e6", border: "1px solid #f47738", borderLeft: "6px solid #f47738", padding: "16px 20px", margin: "20px 0" }}>
                        <p style={{ fontSize: 15, fontWeight: 700, color: "#0b0c0c", marginBottom: 4 }}>Vault not indexed</p>
                        <p style={{ fontSize: 14, color: "#505a5f" }}>Click "Index Vault" above to prepare documents for searching.</p>
                      </div>
                    )}

                    {pdfs.length === 0 && !isRunning && (
                      <div style={{ background: "#e8f0fe", border: "1px solid #1d70b8", borderLeft: "6px solid #1d70b8", padding: "16px 20px", margin: "20px 0" }}>
                        <p style={{ fontSize: 15, fontWeight: 700, color: "#0b0c0c", marginBottom: 4 }}>No documents uploaded</p>
                        <p style={{ fontSize: 14, color: "#505a5f" }}>Use the panel on the left to upload PDF documents to this vault.</p>
                      </div>
                    )}
                  </div>

                  {/* Question input */}
                  {vaultIndex && (
                    <div style={{ padding: "16px 24px", borderTop: "3px solid #4a7c20", background: "#ffffff", flexShrink: 0 }}>
                      <label style={{ fontSize: 14, fontWeight: 700, color: "#0b0c0c", display: "block", marginBottom: 6 }}>
                        Search the approved documents
                      </label>
                      <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                        <textarea value={question} onChange={e => setQuestion(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askQuestion(); } }}
                          placeholder="Enter your question… (press Enter to search)"
                          disabled={isRunning} rows={2} className="govuk-input"
                          style={{ flex: 1, border: "2px solid #0b0c0c", padding: "10px 12px", color: "#0b0c0c", fontSize: 14, outline: "none", resize: "none", lineHeight: 1.5, fontFamily: "Arial, sans-serif", opacity: isRunning ? 0.6 : 1, background: isRunning ? "#f3f2f1" : "#ffffff" }} />
                        <button className="btn" onClick={askQuestion} disabled={isRunning || !question.trim()}
                          style={{ background: isRunning || !question.trim() ? "#f3f2f1" : "#4a7c20", color: isRunning || !question.trim() ? "#6f777b" : "#ffffff", padding: "0 20px", fontSize: 15, fontWeight: 700, height: 58, display: "flex", alignItems: "center", justifyContent: "center", border: isRunning || !question.trim() ? "1px solid #b1b4b6" : "none", minWidth: 80 }}>
                          {isRunning ? <Spinner size={16} /> : "Search"}
                        </button>
                      </div>
                      <p style={{ fontSize: 11, color: "#6f777b", marginTop: 6 }}>AI-powered search · selects most relevant pages · target under 1p per search</p>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
