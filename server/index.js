const express = require("express");
const cors = require("cors");
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { PDFDocument } = require("pdf-lib");

const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));

// ── R2 CLIENT ────────────────────────────────────────────────────────────────
const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET || "vaultmind-docs";

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ── GEMINI PROXY ─────────────────────────────────────────────────────────────
app.post("/api/claude", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set." });

  try {
    const { system, messages, max_tokens } = req.body;
    const contents = [];
    if (system) {
      contents.push({ role: "user", parts: [{ text: `SYSTEM: ${system}` }] });
      contents.push({ role: "model", parts: [{ text: "Understood." }] });
    }
    messages.forEach(m => {
      const parts = [];
      if (typeof m.content === "string") parts.push({ text: m.content });
      else if (Array.isArray(m.content)) {
        m.content.forEach(c => {
          if (c.type === "text") parts.push({ text: c.text });
          if (c.type === "document") parts.push({ inline_data: { mime_type: "application/pdf", data: c.source.data } });
        });
      }
      contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
    });

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents, generationConfig: { temperature: 0.1 } })
    });

    const data = await response.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();
    res.json({ content: [{ type: "text", text }] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── VAULT LISTING ────────────────────────────────────────────────────────────
app.get("/api/vaults", async (req, res) => {
  try {
    const data = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Delimiter: "/" }));
    const list = (data.CommonPrefixes || []).map(p => ({
      id: p.Prefix.replace("/", ""),
      name: p.Prefix.replace("/", "")
    }));
    res.json({ vaults: list, list: list });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── VAULT DETAILS (PDF LIST) - FIXED 404 ISSUE ───────────────────────────────
app.get("/api/vaults/:id", async (req, res) => {
  try {
    // Decode the ID (handles spaces like "Approved Documents")
    const vaultId = decodeURIComponent(req.params.id);
    const prefix = vaultId.endsWith("/") ? vaultId : `${vaultId}/`;

    const data = await r2.send(new ListObjectsV2Command({ 
      Bucket: BUCKET, 
      Prefix: prefix 
    }));

    const pdfs = (data.Contents || [])
      .filter(f => f.Key.toLowerCase().endsWith(".pdf"))
      .map(f => ({ 
        id: f.Key, 
        name: f.Key.replace(prefix, ""), 
        size: f.Size, 
        key: f.Key 
      }));

    res.json({ pdfs, files: pdfs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── INDEX ROUTES ─────────────────────────────────────────────────────────────
app.get("/api/vaults/:id/index", async (req, res) => {
  try {
    const vaultId = decodeURIComponent(req.params.id);
    const data = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${vaultId}/.index.json` }));
    const body = await streamToBuffer(data.Body);
    res.json(JSON.parse(body.toString()));
  } catch (err) { res.json({ headings: [] }); }
});

app.post("/api/vaults/:id/index", async (req, res) => {
  try {
    const vaultId = decodeURIComponent(req.params.id);
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${vaultId}/.index.json`,
      Body: JSON.stringify(req.body),
      ContentType: "application/json"
    }));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── EXTRACTION ───────────────────────────────────────────────────────────────
app.post("/api/extract-pages", async (req, res) => {
  try {
    const { base64, pages } = req.body;
    const pdfBytes = Buffer.from(base64, "base64");
    const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const extractedDoc = await PDFDocument.create();
    const indices = pages.map(p => p - 1).filter(i => i >= 0 && i < srcDoc.getPageCount());
    const copied = await extractedDoc.copyPages(srcDoc, indices);
    copied.forEach(p => extractedDoc.addPage(p));
    const finalBase64 = Buffer.from(await extractedDoc.save()).toString("base64");
    res.json({ base64: finalBase64 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
