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

  // ── question answering ──────────────────────────────────────────────────────
  const askQuestion = async () => {
    if (!vaultIndex || !question.trim()) return;
    const q = question.trim();
    setAnswer(null);
    setCostEst(null);
    setQuestion("");
    setStage("selecting");
    setProgress({ index: 100, select: 0, read: 0, answer: 0 });
    setStatusMsg("Step 1/3 · Selecting most relevant sections…");

    try {
      const indexSummary = JSON.stringify(vaultIndex).slice(0, 8000);
      const selectionText = await callClaude(
        [{ role: "user", content: `Document Index:\n${indexSummary}\n\nQuestion: ${q}\n\nRespond ONLY as JSON: {"selected": [{"docName": "...", "sections": ["heading1"], "reason": "..."}], "styleNotes": "describe writing style briefly"}` }],
        "Select relevant document sections based on an index. Return pure JSON only.",
        800
      );
      setProgress(p => ({ ...p, select: 100 }));

      let selection = { selected: [], styleNotes: "" };
      try { selection = JSON.parse(selectionText.replace(/```json|```/g, "").trim()); } catch {}

      setStage("reading");
      setStatusMsg("Step 2/3 · Loading selected documents…");

      const relevantNames = (selection.selected || []).map(s => s.docName);
      const docsToRead = pdfs.filter(p => relevantNames.some(n => p.name.includes(n) || n.includes(p.name)));
      const finalDocs = docsToRead.length > 0 ? docsToRead : pdfs.slice(0, 2);

      // Load PDFs from R2
      const loadedDocs = [];
      for (const pdf of finalDocs) {
        const pdfData = await api(`/api/vaults/${vault.id}/pdfs/${encodeURIComponent(pdf.name)}`);
        loadedDocs.push({ ...pdf, base64: pdfData.base64 });
      }

      setProgress(p => ({ ...p, read: 100 }));
      setStage("answering");
      setStatusMsg("Step 3/3 · Synthesising answer…");

      const docBlocks = loadedDocs.map(pdf => ({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
        title: pdf.name,
      }));

      const focusSections = (selection.selected || []).map(s => s.sections?.join(", ")).filter(Boolean).join("; ");
      const answerPrompt = `Answer the question thoroughly using ONLY information from the provided documents.\n\nSTYLE: ${selection.styleNotes || "professional, structured"}\nFOCUS SECTIONS: ${focusSections || "all relevant sections"}\n\nFORMATTING:\n- Use ## and ### headings\n- Use | tables | for structured data\n- Use bullet points for lists\n- Use **bold** for key terms\n- Cite source documents\n\nQuestion: ${q}`;

      const finalAnswer = await callClaude(
        [{ role: "user", content: [...docBlocks, { type: "text", text: answerPrompt }] }],
        "You are an expert research analyst. Answer questions by synthesising document content. Match the style of source documents.",
        2000
      );

      setProgress(p => ({ ...p, answer: 100 }));
      setAnswer(finalAnswer);
      setStage("done");
      setHistory(prev => [...prev, { vaultId: vault.id, question: q, answer: finalAnswer, timestamp: new Date() }]);

      const estimatedTokens = (indexSummary.length + answerPrompt.length + loadedDocs.length * 15000) / 4;
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
                    <ProgressBar label="1. Index scan" pct={progress.index} />
                    <ProgressBar label="2. Page selection" pct={progress.select} color="#6a8a5a" />
                    <ProgressBar label="3. Deep read" pct={progress.read} color="#5a7a8a" />
                    <ProgressBar label="4. Answer synthesis" pct={progress.answer} color="#8a6a9a" />
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
                        <div key={i} style={{ marginBottom: 20, opacity: 0.6 }}>
                          <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>Q: {h.question}</div>
                          <div style={{ background: "#0f0e0c", border: "1px solid #1e1c18", borderRadius: 10, padding: "14px 18px", maxHeight: 120, overflow: "hidden", position: "relative" }}>
                            <AnswerRenderer text={h.answer} />
                            <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 40, background: "linear-gradient(transparent,#0f0e0c)" }} />
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
import { useState, useRef, useCallback } from "react";

// ── API config ────────────────────────────────────────────────────────────────
// In Replit: calls your secure backend proxy at /api/claude (API key stays server-side)
// In Claude.ai demo mode: returns realistic mock data so you can test the UI
const IS_DEMO = false;
const API_BASE = "https://vaultmind-production-5775.up.railway.app";
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

// ── helpers ───────────────────────────────────────────────────────────────────

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("Read failed"));
    r.readAsDataURL(file);
  });
}

// Demo mock responses for testing in Claude.ai
const DEMO_INDEX = {
  documents: [
    {
      name: "sample.pdf",
      headings: [
        { level: 1, title: "Executive Summary", pageHint: "1" },
        { level: 2, title: "Key Findings", pageHint: "3" },
        { level: 2, title: "Financial Overview", pageHint: "8" },
        { level: 1, title: "Market Analysis", pageHint: "12" },
        { level: 2, title: "Competitor Landscape", pageHint: "15" },
        { level: 1, title: "Recommendations", pageHint: "22" },
      ],
    },
  ],
  styleNotes: "Professional business report style, uses structured tables for data, formal tone",
};

const DEMO_ANSWER = `## Key Findings

Based on the vault documents, here is a thorough answer to your question:

### Summary

The documents outline **three primary areas** of focus relevant to your query.

### Data Overview

| Category | Value | Change |
|---|---|---|
| Revenue Q1 | £2.4M | +12% |
| Revenue Q2 | £2.7M | +14% |
| Market Share | 18.3% | +2.1pp |
| Customer Count | 4,820 | +340 |

### Detailed Analysis

The documents highlight the following key points:

- **Growth trajectory** has been consistently positive over the reviewed period
- **Market conditions** remain favourable according to Section 3.2
- **Risk factors** identified include supply chain exposure and regulatory changes

### Recommendations

The vault documents recommend the following approach:

1. Prioritise investment in the top-performing segments
2. Review quarterly targets against the updated market benchmarks
3. Escalate flagged risks to the senior leadership team by Q3

> *Source: Executive Summary (p.1), Financial Overview (p.8), Recommendations (p.22)*`;

async function callClaude(messages, systemPrompt, maxTokens = 1000) {
  if (IS_DEMO) {
    // Simulate API delay
    await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
    // Return mock index or mock answer based on system prompt content
    if (systemPrompt.includes("indexer")) return JSON.stringify(DEMO_INDEX);
    if (systemPrompt.includes("select")) return JSON.stringify({ selected: [{ docName: "sample.pdf", sections: ["Executive Summary", "Financial Overview"], reason: "Most relevant to query" }], styleNotes: "Professional business report" });
    return DEMO_ANSWER;
  }

  // Production: call your secure backend proxy
  const res = await fetch("https://vaultmind-production-5775.up.railway.app/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `API error ${res.status}`);
  }
  const data = await res.json();
  return data.content.map((b) => b.text || "").join("\n");
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
    const rows = tableBuffer.map((r) => r.split("|").map((c) => c.trim()).filter((c) => c !== ""));
    const header = rows[0];
    const body = rows.slice(2);
    elements.push(
      <div key={`tbl-${key}`} style={{ overflowX: "auto", margin: "16px 0" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr>{header.map((h, i) => (
              <th key={i} style={{ background: "#1e1b14", color: "#c8a96e", padding: "8px 12px", border: "1px solid #333", textAlign: "left", fontFamily: "'Playfair Display', serif" }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri} style={{ background: ri % 2 === 0 ? "#141414" : "#181818" }}>
                {row.map((cell, ci) => (
                  <td key={ci} style={{ padding: "7px 12px", border: "1px solid #2a2a2a", color: "#ccc", verticalAlign: "top" }}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    tableBuffer = [];
    inTable = false;
  };

  lines.forEach((line, i) => {
    if (line.startsWith("|")) { inTable = true; tableBuffer.push(line); return; }
    if (inTable) flushTable(i);
    if (line.startsWith("### ")) {
      elements.push(<h3 key={i} style={{ color: "#c8a96e", fontFamily: "'Playfair Display', serif", fontSize: 15, margin: "18px 0 6px", fontWeight: 600 }}>{line.slice(4)}</h3>);
    } else if (line.startsWith("## ")) {
      elements.push(<h2 key={i} style={{ color: "#e8d5a3", fontFamily: "'Playfair Display', serif", fontSize: 18, margin: "22px 0 8px", borderBottom: "1px solid #333", paddingBottom: 6 }}>{line.slice(3)}</h2>);
    } else if (line.startsWith("# ")) {
      elements.push(<h1 key={i} style={{ color: "#e8d5a3", fontFamily: "'Playfair Display', serif", fontSize: 22, margin: "24px 0 10px" }}>{line.slice(2)}</h1>);
    } else if (line.startsWith("> ")) {
      elements.push(<blockquote key={i} style={{ borderLeft: "2px solid #c8a96e", paddingLeft: 12, color: "#888", fontStyle: "italic", fontSize: 12, margin: "10px 0" }}>{line.slice(2)}</blockquote>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(<li key={i} style={{ color: "#ccc", fontSize: 13.5, lineHeight: 1.7, marginLeft: 18 }}>{formatInline(line.slice(2))}</li>);
    } else if (line.match(/^\d+\. /)) {
      elements.push(<li key={i} style={{ color: "#ccc", fontSize: 13.5, lineHeight: 1.7, marginLeft: 18, listStyleType: "decimal" }}>{formatInline(line.replace(/^\d+\. /, ""))}</li>);
    } else if (line === "") {
      elements.push(<div key={i} style={{ height: 10 }} />);
    } else {
      elements.push(<p key={i} style={{ color: "#ccc", fontSize: 13.5, lineHeight: 1.75, margin: "4px 0" }}>{formatInline(line)}</p>);
    }
  });
  if (inTable) flushTable("end");
  return <div>{elements}</div>;
}

// ── main app ──────────────────────────────────────────────────────────────────

export default function App() {
  const [vaults, setVaults] = useState([]);
  const [selectedVault, setSelectedVault] = useState(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState(null);
  const [stage, setStage] = useState(null);
  const [progress, setProgress] = useState({ index: 0, select: 0, read: 0, answer: 0 });
  const [statusMsg, setStatusMsg] = useState("");
  const [creating, setCreating] = useState(false);
  const [newVaultName, setNewVaultName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [costEst, setCostEst] = useState(null);
  const [history, setHistory] = useState([]); // conversation history per vault
  const fileInputRef = useRef();

  const vault = vaults.find((v) => v.id === selectedVault);
  const vaultHistory = history.filter((h) => h.vaultId === selectedVault);

  // ── vault creation ──────────────────────────────────────────────────────────
  const createVault = () => {
    if (!newVaultName.trim()) return;
    const v = { id: Date.now(), name: newVaultName.trim(), pdfs: [], index: null };
    setVaults((p) => [...p, v]);
    setSelectedVault(v.id);
    setNewVaultName("");
    setCreating(false);
  };

  const addPDFs = useCallback(async (files) => {
    if (!vault) return;
    const pdfFiles = Array.from(files).filter((f) => f.type === "application/pdf");
    if (!pdfFiles.length) return;
    const newPdfs = pdfFiles.map((f) => ({ id: Date.now() + Math.random(), name: f.name, file: f, base64: null, size: f.size }));
    setVaults((prev) => prev.map((v) => v.id === vault.id ? { ...v, pdfs: [...v.pdfs, ...newPdfs], index: null } : v));
    for (const pdf of newPdfs) {
      const b64 = await fileToBase64(pdf.file);
      setVaults((prev) => prev.map((v) => ({ ...v, pdfs: v.pdfs.map((p) => p.id === pdf.id ? { ...p, base64: b64 } : p) })));
    }
  }, [vault]);

  const onDrop = (e) => { e.preventDefault(); setDragOver(false); addPDFs(e.dataTransfer.files); };

  // ── indexing ────────────────────────────────────────────────────────────────
  const indexVault = async () => {
    if (!vault || vault.pdfs.length === 0) return;
    const readyPdfs = IS_DEMO ? [{ id: 1, name: "sample.pdf", base64: "demo", size: 204800 }] : vault.pdfs.filter((p) => p.base64);
    if (!IS_DEMO && readyPdfs.length === 0) return;

    setStage("indexing");
    setProgress({ index: 0, select: 0, read: 0, answer: 0 });
    setStatusMsg("Scanning document structure — this may take a minute for large files…");
    setAnswer(null);

    try {
      const allDocuments = [];

      for (let i = 0; i < readyPdfs.length; i++) {
        const pdf = readyPdfs[i];
        setStatusMsg(`Scanning document ${i + 1} of ${readyPdfs.length}: ${pdf.name}…`);
        setProgress((p) => ({ ...p, index: Math.round((i / readyPdfs.length) * 80) }));

        if (IS_DEMO) {
          allDocuments.push({ name: pdf.name, headings: [] });
          continue;
        }

        let docIndex = { name: pdf.name, headings: [] };
        try {
          const contentBlocks = [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.base64 }, title: pdf.name },
            { type: "text", text: 'Extract ALL structural metadata from this document: title, every section heading, sub-heading, chapter name, table of contents entry, figure and table caption. Be thorough. Output ONLY valid JSON, no other text: {"name": "document name", "headings": [{"level": 1, "title": "heading text", "pageHint": "page or section"}]}' }
          ];

          const indexText = await callClaude(
            [{ role: "user", content: contentBlocks }],
            "You are a document indexer. Extract only structural metadata. Return pure JSON only, no markdown fences, no explanation.",
            4000
          );

          // Robust JSON extraction — three fallback strategies
          let parsed = null;
          const clean = indexText.replace(/```json|```/g, "").trim();

          try { parsed = JSON.parse(clean); } catch {}

          if (!parsed) {
            const match = clean.match(/\{[\s\S]*\}/);
            if (match) try { parsed = JSON.parse(match[0]); } catch {}
          }

          if (!parsed) {
            const hMatch = clean.match(/"headings"\s*:\s*(\[[\s\S]*?\])/);
            if (hMatch) try { parsed = { name: pdf.name, headings: JSON.parse(hMatch[1]) }; } catch {}
          }

          if (parsed) docIndex = { name: pdf.name, headings: parsed.headings || [] };
        } catch (e) {
          console.warn(`Could not index ${pdf.name}:`, e);
        }

        allDocuments.push(docIndex);
      }

      setProgress((p) => ({ ...p, index: 100 }));
      const indexData = { documents: allDocuments };
      setVaults((prev) => prev.map((v) => v.id === vault.id ? { ...v, index: indexData, pdfs: readyPdfs } : v));
      setStage("done-index");
      const totalHeadings = allDocuments.reduce((sum, d) => sum + (d.headings?.length || 0), 0);
      setStatusMsg(IS_DEMO ? "✓ Demo vault indexed — ask a question to see a sample answer." : `✓ Vault indexed — ${totalHeadings} sections mapped across ${allDocuments.length} document${allDocuments.length !== 1 ? "s" : ""}. Ready for questions.`);
    } catch (err) {
      setStage(null);
      setStatusMsg("Indexing failed: " + err.message);
    }
  };

  // ── question answering pipeline ─────────────────────────────────────────────
  const askQuestion = async () => {
    if (!vault?.index || !question.trim()) return;
    const q = question.trim();
    setAnswer(null);
    setCostEst(null);
    setQuestion("");
    setStage("selecting");
    setProgress({ index: 100, select: 0, read: 0, answer: 0 });
    setStatusMsg("Step 1/3 · Probabilistically selecting most relevant sections…");

    try {
      const indexSummary = JSON.stringify(vault.index).slice(0, 8000);

      // STEP 1: cheap selection pass
      const selectionPrompt = `You are an expert research assistant. Given a document index and a user question, identify which document sections are MOST LIKELY to contain the answer.\n\nDocument Index:\n${indexSummary}\n\nUser Question: ${q}\n\nRespond ONLY as JSON: {"selected": [{"docName": "...", "sections": ["heading1", "heading2"], "reason": "..."}], "styleNotes": "describe the writing style, tone and format of the documents briefly"}`;
      const selectionText = await callClaude(
        [{ role: "user", content: selectionPrompt }],
        "You select relevant document sections based on an index. Return pure JSON only.",
        800
      );
      setProgress((p) => ({ ...p, select: 100 }));

      let selection;
      try {
        const clean = selectionText.replace(/```json|```/g, "").trim();
        selection = JSON.parse(clean);
      } catch { selection = { selected: [], styleNotes: "" }; }

      setStage("reading");
      setStatusMsg("Step 2/3 · Deep-reading selected pages (≤100 pages)…");

      const relevantDocNames = (selection.selected || []).map((s) => s.docName);
      const docsToRead = IS_DEMO ? vault.pdfs : vault.pdfs.filter((p) =>
        relevantDocNames.some((n) => p.name.includes(n) || n.includes(p.name)) || relevantDocNames.length === 0
      );
      const finalDocs = docsToRead.length > 0 ? docsToRead : vault.pdfs.slice(0, 3);

      setProgress((p) => ({ ...p, read: 100 }));
      setStage("answering");
      setStatusMsg("Step 3/3 · Synthesising answer in vault style…");

      const docBlocks = IS_DEMO ? [] : finalDocs.map((pdf) => ({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
        title: pdf.name,
      }));

      const styleNotes = selection.styleNotes || "professional, structured";
      const focusSections = (selection.selected || []).map((s) => s.sections?.join(", ")).filter(Boolean).join("; ");

      const answerPrompt = `You are an expert analyst. Answer the user's question thoroughly using ONLY information from the provided documents.\n\nSTYLE REQUIREMENTS (match the vault documents exactly):\n${styleNotes}\n\nFOCUS: Pay special attention to sections: ${focusSections || "all relevant sections"}\n\nFORMATTING RULES:\n- Use markdown headings (##, ###) to structure your answer\n- Use | tables | for any comparative or structured data\n- Use bullet points for lists\n- Use **bold** for key terms\n- Be thorough but concise\n- Cite which document each point comes from\n\nQuestion: ${q}`;

      const finalAnswer = await callClaude(
        [{ role: "user", content: [...docBlocks, { type: "text", text: answerPrompt }] }],
        "You are an expert research analyst who answers questions by synthesising document content. Match the style of the source documents.",
        2000
      );

      setProgress((p) => ({ ...p, answer: 100 }));
      setAnswer(finalAnswer);
      setStage("done");

      // Save to history
      setHistory((prev) => [...prev, { vaultId: vault.id, question: q, answer: finalAnswer, timestamp: new Date() }]);

      const estimatedInputTokens = (indexSummary.length + answerPrompt.length + finalDocs.length * 15000) / 4;
      const costGBP = (estimatedInputTokens / 1_000_000) * 3 * 0.79;
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
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: #111; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .vault-item { cursor: pointer; transition: background 0.2s; }
        .vault-item:hover { background: #1c1a14 !important; }
        .btn { cursor: pointer; transition: all 0.15s; border: none; }
        .btn:hover { filter: brightness(1.15); }
        .btn:disabled { cursor: not-allowed; }
      `}</style>

      {/* ── sidebar ── */}
      <div style={{ width: 260, minHeight: "100vh", borderRight: "1px solid #1e1c18", background: "#0b0a08", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ padding: "24px 20px 16px", borderBottom: "1px solid #1e1c18" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <div style={{ width: 28, height: 28, background: "linear-gradient(135deg,#c8a96e,#8b6914)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>⬡</div>
            <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, color: "#e8d5a3", fontWeight: 600 }}>VaultMind</span>
          </div>
          <p style={{ fontSize: 10, color: "#555", marginTop: 2, letterSpacing: "0.08em", textTransform: "uppercase" }}>Document Intelligence</p>
          {IS_DEMO && (
            <div style={{ marginTop: 8, background: "#1a1508", border: "1px solid #3a2a08", borderRadius: 6, padding: "5px 8px", fontSize: 10, color: "#c8a96e" }}>
              ✦ Demo mode — UI preview only
            </div>
          )}
        </div>

        <div style={{ padding: "14px 14px 8px", fontSize: 10, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase" }}>Vaults</div>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {vaults.map((v) => (
            <div key={v.id} className="vault-item"
              onClick={() => { setSelectedVault(v.id); setAnswer(null); setStage(null); setStatusMsg(""); setCostEst(null); }}
              style={{ padding: "10px 16px", background: selectedVault === v.id ? "#1c1a14" : "transparent", borderLeft: selectedVault === v.id ? "2px solid #c8a96e" : "2px solid transparent" }}>
              <div style={{ fontSize: 13, color: selectedVault === v.id ? "#e8d5a3" : "#aaa", fontWeight: selectedVault === v.id ? 500 : 400 }}>{v.name}</div>
              <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{v.pdfs.length} doc{v.pdfs.length !== 1 ? "s" : ""} · {v.index ? "✓ indexed" : "not indexed"}</div>
            </div>
          ))}
        </div>

        {creating ? (
          <div style={{ padding: "12px 14px", borderTop: "1px solid #1e1c18" }}>
            <input value={newVaultName} onChange={(e) => setNewVaultName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createVault()}
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

      {/* ── main ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: "100vh", maxHeight: "100vh", overflow: "hidden" }}>

        {!vault ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, opacity: 0.4 }}>
            <div style={{ fontSize: 48 }}>⬡</div>
            <p style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: "#888" }}>Select or create a vault</p>
            <p style={{ fontSize: 12, color: "#555" }}>Upload PDFs, index them, then ask questions</p>
            {IS_DEMO && <p style={{ fontSize: 11, color: "#666", marginTop: 8 }}>Create a vault and click "Index Vault" to see the demo</p>}
          </div>
        ) : (
          <>
            {/* header */}
            <div style={{ padding: "18px 28px", borderBottom: "1px solid #1e1c18", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <div>
                <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: "#e8d5a3", fontWeight: 600 }}>{vault.name}</h1>
                <p style={{ fontSize: 11, color: "#555", marginTop: 3 }}>
                  {IS_DEMO ? "Demo vault" : `${vault.pdfs.length} document${vault.pdfs.length !== 1 ? "s" : ""}`} · {vault.index ? "Indexed & ready" : "Needs indexing"}
                </p>
              </div>
              {!vault.index && (
                <button className="btn" onClick={indexVault} disabled={isRunning}
                  style={{ background: "linear-gradient(135deg,#c8a96e,#8b6914)", color: "#0e0d0b", borderRadius: 8, padding: "9px 20px", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 8, opacity: isRunning ? 0.6 : 1 }}>
                  {stage === "indexing" ? <><Spinner size={13} /> Indexing…</> : "⬡ Index Vault"}
                </button>
              )}
              {vault.index && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#6a8a5a" }}>
                  <span style={{ width: 7, height: 7, background: "#6a8a5a", borderRadius: "50%", display: "inline-block" }} />
                  Indexed
                </div>
              )}
            </div>

            <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

              {/* ── left: PDF list + upload ── */}
              {!IS_DEMO && (
                <div style={{ width: 240, borderRight: "1px solid #1e1c18", display: "flex", flexDirection: "column", flexShrink: 0 }}>
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={onDrop}
                    onClick={() => fileInputRef.current.click()}
                    style={{ margin: 12, border: `1.5px dashed ${dragOver ? "#c8a96e" : "#2a2820"}`, borderRadius: 10, padding: "14px 10px", textAlign: "center", cursor: "pointer", transition: "border-color 0.2s", background: dragOver ? "#1a1710" : "transparent" }}>
                    <div style={{ fontSize: 22, marginBottom: 4 }}>📄</div>
                    <p style={{ fontSize: 11, color: "#666", lineHeight: 1.5 }}>Drop PDFs here<br />or click to browse</p>
                    <input ref={fileInputRef} type="file" multiple accept="application/pdf" style={{ display: "none" }} onChange={(e) => addPDFs(e.target.files)} />
                  </div>
                  <div style={{ flex: 1, overflowY: "auto" }}>
                    {vault.pdfs.map((pdf) => (
                      <div key={pdf.id} style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 16 }}>📄</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, color: "#bbb", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pdf.name}</div>
                          <div style={{ fontSize: 10, color: "#444", marginTop: 1 }}>
                            {pdf.base64 ? `${(pdf.size / 1024).toFixed(0)} KB` : <span style={{ color: "#888", display: "flex", alignItems: "center", gap: 4 }}><Spinner size={8} /> loading…</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                    {vault.pdfs.length === 0 && <p style={{ fontSize: 11, color: "#444", textAlign: "center", marginTop: 20 }}>No documents yet</p>}
                  </div>
                </div>
              )}

              {/* ── right: Q&A panel ── */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

                {/* progress */}
                {isRunning && (
                  <div style={{ padding: "16px 24px", borderBottom: "1px solid #1e1c18", background: "#0c0b09", animation: "fadeIn 0.3s ease", flexShrink: 0 }}>
                    <div style={{ fontSize: 12, color: "#c8a96e", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                      <Spinner size={12} /> {statusMsg}
                    </div>
                    <ProgressBar label="1. Index scan" pct={progress.index} />
                    <ProgressBar label="2. Page selection (top ~100)" pct={progress.select} color="#6a8a5a" />
                    <ProgressBar label="3. Deep read" pct={progress.read} color="#5a7a8a" />
                    <ProgressBar label="4. Answer synthesis" pct={progress.answer} color="#8a6a9a" />
                  </div>
                )}

                {/* status */}
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

                {/* history + answer */}
                <div style={{ flex: 1, overflowY: "auto", padding: "20px 28px" }}>
                  {/* past Q&A */}
                  {vaultHistory.length > 0 && (
                    <div style={{ marginBottom: 24 }}>
                      {vaultHistory.map((h, i) => (
                        <div key={i} style={{ marginBottom: 20, opacity: 0.6 }}>
                          <div style={{ fontSize: 12, color: "#888", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ color: "#555" }}>Q</span> {h.question}
                          </div>
                          <div style={{ background: "#0f0e0c", border: "1px solid #1e1c18", borderRadius: 10, padding: "14px 18px", maxHeight: 120, overflow: "hidden", position: "relative" }}>
                            <AnswerRenderer text={h.answer} />
                            <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 40, background: "linear-gradient(transparent,#0f0e0c)" }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* current answer */}
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

                  {!answer && !isRunning && vault.index && vaultHistory.length === 0 && (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", opacity: 0.35, gap: 10 }}>
                      <div style={{ fontSize: 36 }}>💬</div>
                      <p style={{ fontFamily: "'Playfair Display', serif", color: "#888", fontSize: 16 }}>Ask anything about this vault</p>
                      <p style={{ fontSize: 11, color: "#555" }}>AI selects the most relevant ~100 pages before answering</p>
                    </div>
                  )}

                  {!vault.index && (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", opacity: 0.4, gap: 10 }}>
                      <div style={{ fontSize: 36 }}>⬡</div>
                      <p style={{ fontFamily: "'Playfair Display', serif", color: "#888", fontSize: 16 }}>Index this vault first</p>
                      <p style={{ fontSize: 11, color: "#555" }}>Click "Index Vault" to scan document structure</p>
                    </div>
                  )}
                </div>

                {/* question input */}
                {vault.index && (
                  <div style={{ padding: "16px 24px", borderTop: "1px solid #1e1c18", background: "#0b0a08", flexShrink: 0 }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                      <textarea
                        value={question}
                        onChange={(e) => setQuestion(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askQuestion(); } }}
                        placeholder="Ask a question about this vault… (Enter to send, Shift+Enter for new line)"
                        disabled={isRunning}
                        rows={2}
                        style={{ flex: 1, background: "#141210", border: "1px solid #2a2820", borderRadius: 10, padding: "11px 14px", color: "#ddd", fontSize: 13, outline: "none", resize: "none", lineHeight: 1.6, fontFamily: "inherit", opacity: isRunning ? 0.6 : 1 }}
                      />
                      <button className="btn" onClick={askQuestion} disabled={isRunning || !question.trim()}
                        style={{ background: isRunning || !question.trim() ? "#1a1814" : "linear-gradient(135deg,#c8a96e,#8b6914)", color: isRunning || !question.trim() ? "#555" : "#0e0d0b", borderRadius: 10, padding: "11px 18px", fontSize: 16, fontWeight: 700, height: 54, width: 54, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {isRunning ? <Spinner size={14} /> : "→"}
                      </button>
                    </div>
                    <p style={{ fontSize: 10, color: "#3a3830", marginTop: 6, textAlign: "right" }}>
                      {IS_DEMO ? "Demo mode · deploy to Replit for live API" : "2-pass AI pipeline · target < 1p / question"}
                    </p>
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
