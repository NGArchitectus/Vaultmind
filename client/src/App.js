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
    const srcDoc = await PDFDocument.load(pdfBytes);
    const totalPages = srcDoc.getPageCount();
    const chunks = [];
    for (let start = 0; start < totalPages; start += chunkSize) {
      const end = Math.min(start + chunkSize, totalPages);
      const chunkDoc = await PDFDocument.create();
      const pages = await chunkDoc.copyPages(srcDoc, Array.from({ length: end - start }, (_, i) => start + i));
      pages.forEach(p => chunkDoc.addPage(p));
      const chunkBytes = await chunkDoc.save();
      const chunkBase64 = btoa(String.fromCharCode(...chunkBytes));
      chunks.push({ base64: chunkBase64, startPage: start + 1, endPage: end, totalPages });
    }
    return chunks;
  } catch (e) {
    console.warn("PDF splitting failed:", e);
    return [{ base64: base64Data, startPage: 1, endPage: "?", totalPages: "?" }];
  }
}

async function callClaude(messages, systemPrompt, maxTokens = 1000) {
  const res = await fetch(`${API_BASE}/api/claude`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system: systemPrompt, messages }),
  });
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

function ProgressBar({ label, pct, color = "#c8a96e" }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#888", marginBottom: 4 }}>
        <span>{label}</span><span>{Math.round(pct)}%</span>
      </div>
      <div style={{ height: 4, background: "#2a2a2a", borderRadius: 2 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 2, transition: "width 0.4s ease" }} />
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
      <div key={`tbl-${key}`} style={{ overflowX: "auto", margin: "16px 0" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead><tr>{header.map((h, i) => <th key={i} style={{ background: "#1e1b14", color: "#c8a96e", padding: "8px 12px", border: "1px solid #333", textAlign: "left", fontFamily: "'Playfair Display', serif" }}>{h}</th>)}</tr></thead>
          <tbody>{body.map((row, ri) => <tr key={ri} style={{ background: ri % 2 === 0 ? "#141414" : "#181818" }}>{row.map((cell, ci) => <td key={ci} style={{ padding: "7px 12px", border: "1px solid #2a2a2a", color: "#ccc", verticalAlign: "top" }}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
    tableBuffer = []; inTable = false;
  };

  lines.forEach((line, i) => {
    if (line.startsWith("|")) { inTable = true; tableBuffer.push(line); return; }
    if (inTable) flushTable(i);
    if (line.startsWith("### ")) elements.push(<h3 key={i} style={{ color: "#c8a96e", fontFamily: "'Playfair Display', serif", fontSize: 15, margin: "18px 0 6px", fontWeight: 600 }}>{line.slice(4)}</h3>);
    else if (line.startsWith("## ")) elements.push(<h2 key={i} style={{ color: "#e8d5a3", fontFamily: "'Playfair Display', serif", fontSize: 18, margin: "22px 0 8px", borderBottom: "1px solid #333", paddingBottom: 6 }}>{line.slice(3)}</h2>);
    else if (line.startsWith("# ")) elements.push(<h1 key={i} style={{ color: "#e8d5a3", fontFamily: "'Playfair Display', serif", fontSize: 22, margin: "24px 0 10px" }}>{line.slice(2)}</h1>);
    else if (line.startsWith("> ")) elements.push(<blockquote key={i} style={{ borderLeft: "2px solid #c8a96e", paddingLeft: 12, color: "#888", fontStyle: "italic", fontSize: 12, margin: "10px 0" }}>{line.slice(2)}</blockquote>);
    else if (line.startsWith("- ") || line.startsWith("* ")) elements.push(<li key={i} style={{ color: "#ccc", fontSize: 13.5, lineHeight: 1.7, marginLeft: 18 }}>{formatInline(line.slice(2))}</li>);
    else if (line.match(/^\d+\. /)) elements.push(<li key={i} style={{ color: "#ccc", fontSize: 13.5, lineHeight: 1.7, marginLeft: 18, listStyleType: "decimal" }}>{formatInline(line.replace(/^\d+\. /, ""))}</li>);
    else if (line === "") elements.push(<div key={i} style={{ height: 10 }} />);
    else elements.push(<p key={i} style={{ color: "#ccc", fontSize: 13.5, lineHeight: 1.75, margin: "4px 0" }}>{formatInline(line)}</p>);
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
          const chunks = await splitPdfIntoChunks(base64, MAX_PAGES_PER_CHUNK);
          const allHeadings = [];

          for (let c = 0; c < chunks.length; c++) {
            const chunk = chunks[c];
            if (chunks.length > 1) setStatusMsg(`Scanning ${pdf.name} — pages ${chunk.startPage}–${chunk.endPage} (chunk ${c + 1}/${chunks.length})…`);

            const contentBlocks = [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: chunk.base64 }, title: `${pdf.name} (pages ${chunk.startPage}-${chunk.endPage})` },
              { type: "text", text: `Extract ALL structural metadata from pages ${chunk.startPage}-${chunk.endPage}: every section heading, sub-heading, chapter name, table of contents entry, figure and table caption. Output ONLY valid JSON: {"headings": [{"level": 1, "title": "heading text", "pageHint": "${chunk.startPage}"}]}` }
            ];

            try {
              const indexText = await callClaude(
                [{ role: "user", content: contentBlocks }],
                "You are a document indexer. Extract only structural metadata. Return pure JSON only, no markdown, no explanation.",
                4000
              );
              let parsed = null;
              const clean = indexText.replace(/```json|```/g, "").trim();
              try { parsed = JSON.parse(clean); } catch {}
              if (!parsed) { const m = clean.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch {} }
              if (!parsed) { const m = clean.match(/"headings"\s*:\s*(\[[\s\S]*?\])/); if (m) try { parsed = { headings: JSON.parse(m[1]) }; } catch {} }
              if (parsed?.headings) allHeadings.push(...parsed.headings);
            } catch (e) {
              console.warn(`Chunk ${c + 1} of ${pdf.name} failed:`, e);
            }
          }
          docIndex = { name: pdf.name, headings: allHeadings };
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

      // Use the stored index text only — no PDFs loaded at all in this pass
      const indexSummary = JSON.stringify(vaultIndex).slice(0, 12000);
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
          "pageHint": "page number or range e.g. 12 or 12-15",
          "probability": 0.95,
          "reason": "why this section is relevant",
          "crossRefs": ["other section headings this likely cross-references"]
        }
      ]
    }
  ]
}

Include ALL sections with probability > 0.3. Always include page numbers where available in the index.`;

      const scoringText = await callClaude(
        [{ role: "user", content: scoringPrompt }],
        "You are a building regulations expert. Score document sections for relevance using only the text index provided. Return pure JSON only, no markdown.",
        2000
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

      // Helper to parse page hints like "12", "12-15", "12,14,16"
      const parsePageNums = (hint, totalPages) => {
        const pages = new Set();
        if (!hint) return pages;
        const str = String(hint).replace(/[^0-9,\-]/g, "");
        str.split(",").forEach(part => {
          const range = part.split("-");
          if (range.length === 2) {
            const start = parseInt(range[0]);
            const end = parseInt(range[1]);
            if (!isNaN(start) && !isNaN(end)) {
              for (let i = start; i <= Math.min(end, totalPages); i++) pages.add(i);
            }
          } else {
            const n = parseInt(part);
            if (!isNaN(n) && n > 0 && n <= totalPages) pages.add(n);
          }
        });
        return pages;
      };

      // Build a ranked list of all sections across all docs, sorted by probability (highest first)
      // This ensures the 90-page budget is spent on the MOST relevant pages first
      const HARD_PAGE_BUDGET = 90;
      const allScoredSections = [];

      (scoring.selectedDocs || []).forEach(selectedDoc => {
        const matchedDoc = contentsData.find(d =>
          d.pdf.name.includes(selectedDoc.docName) || selectedDoc.docName.includes(d.pdf.name)
        );
        if (!matchedDoc) return;
        (selectedDoc.sections || []).forEach(section => {
          const parsed = parsePageNums(section.pageHint, 9999);
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

        // Add pages with 1-page buffer, but only until budget is exhausted
        const pagesToAdd = [];
        section.pages.forEach(p => {
          for (let i = Math.max(1, p - 1); i <= p + 1; i++) {
            if (!docPageMap[key].pages.has(i)) pagesToAdd.push(i);
          }
        });

        // Only add pages if we have budget remaining
        for (const p of pagesToAdd) {
          if (budgetRemaining <= 0) break;
          docPageMap[key].pages.add(p);
          budgetRemaining--;
        }
      }

      // Fallback: if no pages identified, use first 30 pages of most relevant doc
      if (Object.keys(docPageMap).length === 0 && contentsData.length > 0) {
        const fallbackDoc = contentsData[0];
        docPageMap[fallbackDoc.pdf.name] = { contentsDoc: fallbackDoc, pages: new Set() };
        for (let i = 1; i <= 30; i++) docPageMap[fallbackDoc.pdf.name].pages.add(i);
      }

      console.log(`Page budget used: ${HARD_PAGE_BUDGET - budgetRemaining}/${HARD_PAGE_BUDGET} pages across ${Object.keys(docPageMap).length} documents`);

      // Load pdf-lib once before extraction loop
      if (!window.PDFLib) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";
          script.onload = resolve; script.onerror = reject;
          document.head.appendChild(script);
        });
      }
      const { PDFDocument } = window.PDFLib;

      // Extract specific pages from each document using pdf-lib
      // Pages have already been ranked by probability and capped at HARD_PAGE_BUDGET
      const docBlocks = [];
      let totalPagesExtracted = 0;

      for (const [docName, { contentsDoc, pages }] of Object.entries(docPageMap)) {
        setStatusMsg(`Pass 2/3 · Extracting pages from ${docName}…`);
        try {
          const pdfBytes = Uint8Array.from(atob(contentsDoc.base64), c => c.charCodeAt(0));
          const srcDoc = await PDFDocument.load(pdfBytes);
          const totalPages = srcDoc.getPageCount();

          // Convert 1-based page numbers to 0-based indices, filter valid
          const pageIndices = Array.from(pages)
            .map(p => p - 1)
            .filter(i => i >= 0 && i < totalPages)
            .sort((a, b) => a - b);

          if (pageIndices.length === 0) continue;

          const extractedDoc = await PDFDocument.create();
          const copiedPages = await extractedDoc.copyPages(srcDoc, pageIndices);
          copiedPages.forEach(p => extractedDoc.addPage(p));
          const extractedBytes = await extractedDoc.save();

          // Convert to base64 safely for large files
          const chunkSize = 8192;
          let extractedBase64 = "";
          for (let i = 0; i < extractedBytes.length; i += chunkSize) {
            extractedBase64 += btoa(String.fromCharCode(...extractedBytes.slice(i, i + chunkSize)));
          }

          totalPagesExtracted += pageIndices.length;
          docBlocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: extractedBase64 },
            title: `${docName} — pages ${pageIndices.map(i => i + 1).join(", ")}`,
          });
        } catch (e) {
          console.warn(`Page extraction failed for ${docName}:`, e);
          // Fallback: send first 20 pages only — NEVER send full PDF
          try {
            const pdfBytes = Uint8Array.from(atob(contentsDoc.base64), c => c.charCodeAt(0));
            const srcDoc = await PDFDocument.load(pdfBytes);
            const fallbackCount = Math.min(20, srcDoc.getPageCount(), HARD_PAGE_BUDGET - totalPagesExtracted);
            if (fallbackCount <= 0) continue;
            const fallbackDoc = await PDFDocument.create();
            const fallbackPages = await fallbackDoc.copyPages(srcDoc, Array.from({ length: fallbackCount }, (_, i) => i));
            fallbackPages.forEach(p => fallbackDoc.addPage(p));
            const fallbackBytes = await fallbackDoc.save();
            let fallbackBase64 = "";
            const chunkSize = 8192;
            for (let i = 0; i < fallbackBytes.length; i += chunkSize) {
              fallbackBase64 += btoa(String.fromCharCode(...fallbackBytes.slice(i, i + chunkSize)));
            }
            totalPagesExtracted += fallbackCount;
            docBlocks.push({
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: fallbackBase64 },
              title: `${docName} — first ${fallbackCount} pages (fallback)`,
            });
          } catch (e2) {
            console.error(`Complete extraction failure for ${docName}:`, e2);
          }
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

      const answerPrompt = `You are an expert building regulations consultant answering a question using ONLY the provided regulatory documents.

CRITICAL: You must ONLY use information from the documents provided. Do not use any external knowledge or information from outside these specific documents. If the answer cannot be found in these documents, say so explicitly.

VAULT: ${vault.name}
VAULT DOCUMENTS: ${vaultDocNames}
QUESTION: ${q}
PRIORITY SECTIONS IDENTIFIED: ${focusSections || "all sections"}

RESPONSE STRUCTURE — follow this exact structure every time:

## Summary
Write 2-4 sentences giving a direct, concise answer in plain English. This should stand alone as a complete answer.

Immediately after the summary provide the primary citation:
> **[Document Name]** | Section [X.X] — [Heading] | Page [X]
> *"[exact wording from document]"*

---

## Detailed Analysis

Write a thorough, fully reasoned analysis structured using the same headings, numbering and terminology as the source documents. For each point:

1. State the requirement or finding clearly
2. Explain the reasoning behind it in plain English — why does this requirement exist, what does it mean in practice
3. Quote the relevant paragraph(s) directly from the document in full — do not paraphrase when you can quote
4. Provide the inline citation immediately after

Use:
- **Full paragraphs** as the primary format — write proper reasoned prose, not just bullet lists
- **Bullet points** only for lists of specific criteria, dimensions or options within a paragraph
- **Tables** where comparing multiple requirements, dimensions, specifications or options side by side
- **Sub-headings (###)** matching the section headings in the source document
- **Bold** for defined terms, regulation numbers and key requirements

INLINE CITATIONS — after every paragraph or quoted extract, immediately add:
> **[Document Name]** | Section [X.X] — [Heading] | Page [X]
> *"[direct quote of the exact paragraph or sentence from the document]"*

Every point must have its citation and direct quote immediately beneath it. Do not group citations at the end.

---

## Contradictions & Conflicts
List any contradictions, conflicts or ambiguities found between sections or documents. For each conflict provide:
- What the conflict is
- Citation and direct quote for each conflicting statement
If none found, write "No contradictions identified."

---

STYLE REQUIREMENTS:
- Formal, technical style matching the source building regulations
- Same terminology, defined terms and numbering conventions as source material
- Write in full reasoned paragraphs — explain the why, not just the what
- Quote full sentences and paragraphs from the source — do not over-paraphrase
- Precise and unambiguous — this is regulatory guidance
- No external knowledge whatsoever
- If documents do not contain enough information to fully answer, state this explicitly and explain what is missing`;

      const finalAnswer = await callClaude(
        [{ role: "user", content: [...docBlocks, { type: "text", text: answerPrompt }] }],
        `You are an expert building regulations consultant. Answer using ONLY documents from the "${vault.name}" vault. Never use external knowledge. Write in full reasoned paragraphs. Quote directly from source documents. Cite inline after every point.`,
        5000
      );

      setProgress(p => ({ ...p, answer: 100 }));
      setAnswer(finalAnswer);
      setStage("done");
      setHistory(prev => [...prev, { vaultId: vault.id, question: q, answer: finalAnswer, timestamp: new Date() }]);

      const estimatedTokens = (indexSummary.length + answerPrompt.length + finalDocs.length * 15000) / 4;
      const costGBP = (estimatedTokens / 1_000_000) * 3 * 0.79;
      setCostEst(costGBP);
      setStatusMsg(`Answer ready · Est. cost: ${costGBP < 0.01 ? "< 1p" : costGBP.toFixed(2) + "p"}`);
    } catch (err) {
      setStage(null);
      setStatusMsg("Error: " + err.message);
    }
  };

  const isRunning = ["indexing", "selecting", "reading", "answering"].includes(stage);

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", background: "#0e0d0b", minHeight: "100vh", color: "#ddd", display: "flex" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Sans:wght@300;400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-track { background: #111; } ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .vault-item { cursor: pointer; transition: background 0.2s; }
        .vault-item:hover { background: #1c1a14 !important; }
        .btn { cursor: pointer; transition: all 0.15s; border: none; }
        .btn:hover { filter: brightness(1.15); }
        .btn:disabled { cursor: not-allowed; opacity: 0.5; }
      `}</style>

      {/* sidebar */}
      <div style={{ width: 260, minHeight: "100vh", borderRight: "1px solid #1e1c18", background: "#0b0a08", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ padding: "24px 20px 16px", borderBottom: "1px solid #1e1c18" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <div style={{ width: 28, height: 28, background: "linear-gradient(135deg,#c8a96e,#8b6914)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>⬡</div>
            <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, color: "#e8d5a3", fontWeight: 600 }}>VaultMind</span>
          </div>
          <p style={{ fontSize: 10, color: "#555", marginTop: 2, letterSpacing: "0.08em", textTransform: "uppercase" }}>Document Intelligence</p>
        </div>

        <div style={{ padding: "14px 14px 8px", fontSize: 10, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase" }}>Vaults</div>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {loadingVaults ? (
            <div style={{ padding: 16, display: "flex", alignItems: "center", gap: 8, color: "#555", fontSize: 12 }}><Spinner size={12} /> Loading…</div>
          ) : vaults.map(v => (
            <div key={v.id} className="vault-item"
              onClick={() => { setSelectedVault(v.id); setAnswer(null); setStage(null); setCostEst(null); }}
              style={{ padding: "10px 16px", background: selectedVault === v.id ? "#1c1a14" : "transparent", borderLeft: selectedVault === v.id ? "2px solid #c8a96e" : "2px solid transparent" }}>
              <div style={{ fontSize: 13, color: selectedVault === v.id ? "#e8d5a3" : "#aaa", fontWeight: selectedVault === v.id ? 500 : 400 }}>{v.name}</div>
            </div>
          ))}
        </div>

        {creating ? (
          <div style={{ padding: "12px 14px", borderTop: "1px solid #1e1c18" }}>
            <input value={newVaultName} onChange={e => setNewVaultName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && createVault()}
              placeholder="Vault name…" autoFocus
              style={{ width: "100%", background: "#151310", border: "1px solid #333", borderRadius: 6, padding: "7px 10px", color: "#ddd", fontSize: 13, outline: "none", marginBottom: 8 }} />
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn" onClick={createVault} style={{ flex: 1, background: "#c8a96e", color: "#0e0d0b", borderRadius: 6, padding: "6px 0", fontSize: 12, fontWeight: 600 }}>Create</button>
              <button className="btn" onClick={() => setCreating(false)} style={{ flex: 1, background: "#1e1c18", color: "#888", borderRadius: 6, padding: "6px 0", fontSize: 12 }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div style={{ padding: "12px 14px", borderTop: "1px solid #1e1c18" }}>
            <button className="btn" onClick={() => setCreating(true)}
              style={{ width: "100%", background: "#1a1814", border: "1px dashed #333", borderRadius: 8, padding: "9px 0", color: "#777", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <span style={{ fontSize: 16, color: "#555" }}>+</span> New Vault
            </button>
          </div>
        )}
      </div>

      {/* main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: "100vh", maxHeight: "100vh", overflow: "hidden" }}>
        {!vault ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, opacity: 0.4 }}>
            <div style={{ fontSize: 48 }}>⬡</div>
            <p style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: "#888" }}>Select or create a vault</p>
            <p style={{ fontSize: 12, color: "#555" }}>Upload PDFs once — available to your whole team instantly</p>
          </div>
        ) : (
          <>
            {/* header */}
            <div style={{ padding: "18px 28px", borderBottom: "1px solid #1e1c18", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <div>
                <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: "#e8d5a3", fontWeight: 600 }}>{vault.name}</h1>
                <p style={{ fontSize: 11, color: "#555", marginTop: 3 }}>{pdfs.length} document{pdfs.length !== 1 ? "s" : ""} · {vaultIndex ? "✓ Indexed" : "Not indexed"}</p>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                {pdfs.length > 0 && (
                  <button className="btn" onClick={indexVault} disabled={isRunning}
                    style={{ background: vaultIndex ? "#1a1814" : "linear-gradient(135deg,#c8a96e,#8b6914)", color: vaultIndex ? "#888" : "#0e0d0b", border: vaultIndex ? "1px solid #333" : "none", borderRadius: 8, padding: "9px 20px", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                    {stage === "indexing" ? <><Spinner size={13} /> Indexing…</> : vaultIndex ? "Re-index" : "⬡ Index Vault"}
                  </button>
                )}
              </div>
            </div>

            <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
              {/* PDF panel */}
              <div style={{ width: 240, borderRight: "1px solid #1e1c18", display: "flex", flexDirection: "column", flexShrink: 0 }}>
                <div onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
                  onClick={() => fileInputRef.current.click()}
                  style={{ margin: 12, border: `1.5px dashed ${dragOver ? "#c8a96e" : "#2a2820"}`, borderRadius: 10, padding: "14px 10px", textAlign: "center", cursor: "pointer", transition: "border-color 0.2s", background: dragOver ? "#1a1710" : "transparent" }}>
                  {uploadingPdf ? <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "#c8a96e", fontSize: 12 }}><Spinner size={14} /> Uploading…</div> : (
                    <>
                      <div style={{ fontSize: 22, marginBottom: 4 }}>📄</div>
                      <p style={{ fontSize: 11, color: "#666", lineHeight: 1.5 }}>Drop PDFs here<br />or click to browse</p>
                    </>
                  )}
                  <input ref={fileInputRef} type="file" multiple accept="application/pdf" style={{ display: "none" }} onChange={e => addPDFs(e.target.files)} />
                </div>
                <div style={{ flex: 1, overflowY: "auto" }}>
                  {pdfs.map(pdf => (
                    <div key={pdf.id} style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 16 }}>📄</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, color: "#bbb", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pdf.name}</div>
                        <div style={{ fontSize: 10, color: "#444", marginTop: 1 }}>{(pdf.size / 1024).toFixed(0)} KB</div>
                      </div>
                    </div>
                  ))}
                  {pdfs.length === 0 && <p style={{ fontSize: 11, color: "#444", textAlign: "center", marginTop: 20 }}>No documents yet</p>}
                </div>
              </div>

              {/* Q&A panel */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                {isRunning && (
                  <div style={{ padding: "16px 24px", borderBottom: "1px solid #1e1c18", background: "#0c0b09", animation: "fadeIn 0.3s ease", flexShrink: 0 }}>
                    <div style={{ fontSize: 12, color: "#c8a96e", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}><Spinner size={12} /> {statusMsg}</div>
                    <ProgressBar label="Pass 1 · Contents & probability scoring" pct={progress.select} />
                    <ProgressBar label="Pass 2 · Loading selected documents" pct={progress.read} color="#6a8a5a" />
                    <ProgressBar label="Pass 3 · Deep read & answer synthesis" pct={progress.answer} color="#8a6a9a" />
                  </div>
                )}

                {!isRunning && statusMsg && (
                  <div style={{ padding: "8px 24px", borderBottom: "1px solid #1e1c18", fontSize: 11, color: "#888", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
                    <span>{statusMsg}</span>
                    {costEst !== null && (
                      <span style={{ background: costEst < 0.01 ? "#1a2a1a" : "#2a1a0a", border: `1px solid ${costEst < 0.01 ? "#2a4a2a" : "#4a2a0a"}`, color: costEst < 0.01 ? "#6aaa6a" : "#c8a96e", borderRadius: 12, padding: "2px 10px", fontSize: 10, fontWeight: 500 }}>
                        {costEst < 0.01 ? "✓ Under 1p" : `~${(costEst * 100).toFixed(2)}p`}
                      </span>
                    )}
                  </div>
                )}

                <div style={{ flex: 1, overflowY: "auto", padding: "20px 28px" }}>
                  {vaultHistory.length > 0 && (
                    <div style={{ marginBottom: 24 }}>
                      {vaultHistory.map((h, i) => (
                        <div key={i} style={{ marginBottom: 12, opacity: 0.5 }}>
                          <div style={{ fontSize: 11, color: "#888", background: "#0f0e0c", border: "1px solid #1e1c18", borderRadius: 8, padding: "8px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                            <span style={{ color: "#c8a96e", fontWeight: 500 }}>Q:</span>
                            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.question}</span>
                            <span style={{ fontSize: 10, color: "#444", flexShrink: 0 }}>{new Date(h.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {answer && (
                    <div style={{ animation: "fadeIn 0.4s ease" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                        <div style={{ width: 26, height: 26, background: "linear-gradient(135deg,#c8a96e,#8b6914)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>⬡</div>
                        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 13, color: "#888", fontStyle: "italic" }}>Answer from {vault.name}</div>
                      </div>
                      <div style={{ background: "#0f0e0c", border: "1px solid #1e1c18", borderRadius: 12, padding: "20px 24px" }}>
                        <AnswerRenderer text={answer} />
                      </div>
                    </div>
                  )}

                  {!answer && !isRunning && vaultIndex && vaultHistory.length === 0 && (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", opacity: 0.35, gap: 10 }}>
                      <div style={{ fontSize: 36 }}>💬</div>
                      <p style={{ fontFamily: "'Playfair Display', serif", color: "#888", fontSize: 16 }}>Ask anything about this vault</p>
                      <p style={{ fontSize: 11, color: "#555" }}>AI selects the most relevant pages before answering</p>
                    </div>
                  )}

                  {!vaultIndex && !isRunning && pdfs.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", opacity: 0.4, gap: 10 }}>
                      <div style={{ fontSize: 36 }}>⬡</div>
                      <p style={{ fontFamily: "'Playfair Display', serif", color: "#888", fontSize: 16 }}>Index this vault first</p>
                      <p style={{ fontSize: 11, color: "#555" }}>Click "Index Vault" to prepare for questions</p>
                    </div>
                  )}

                  {pdfs.length === 0 && !isRunning && (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", opacity: 0.4, gap: 10 }}>
                      <div style={{ fontSize: 36 }}>📄</div>
                      <p style={{ fontFamily: "'Playfair Display', serif", color: "#888", fontSize: 16 }}>No documents yet</p>
                      <p style={{ fontSize: 11, color: "#555" }}>Upload PDFs using the panel on the left</p>
                    </div>
                  )}
                </div>

                {vaultIndex && (
                  <div style={{ padding: "16px 24px", borderTop: "1px solid #1e1c18", background: "#0b0a08", flexShrink: 0 }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                      <textarea value={question} onChange={e => setQuestion(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askQuestion(); } }}
                        placeholder="Ask a question about this vault… (Enter to send)"
                        disabled={isRunning} rows={2}
                        style={{ flex: 1, background: "#141210", border: "1px solid #2a2820", borderRadius: 10, padding: "11px 14px", color: "#ddd", fontSize: 13, outline: "none", resize: "none", lineHeight: 1.6, fontFamily: "inherit", opacity: isRunning ? 0.6 : 1 }} />
                      <button className="btn" onClick={askQuestion} disabled={isRunning || !question.trim()}
                        style={{ background: isRunning || !question.trim() ? "#1a1814" : "linear-gradient(135deg,#c8a96e,#8b6914)", color: isRunning || !question.trim() ? "#555" : "#0e0d0b", borderRadius: 10, padding: "11px 18px", fontSize: 16, fontWeight: 700, height: 54, width: 54, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {isRunning ? <Spinner size={14} /> : "→"}
                      </button>
                    </div>
                    <p style={{ fontSize: 10, color: "#3a3830", marginTop: 6, textAlign: "right" }}>2-pass AI pipeline · target &lt; 1p / question</p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
