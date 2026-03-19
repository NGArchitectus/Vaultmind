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
      contents.push({
        role: "user",
        parts: [{ text: `SYSTEM INSTRUCTIONS: ${system}\n\nPlease acknowledge.` }]
      }, {
        role: "model",
        parts: [{ text: "Understood." }]
      });
    }

    messages.forEach(m => {
      const parts = [];
      if (typeof m.content === "string") {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        m.content.forEach(c => {
          if (c.type === "text") parts.push({ text: c.text });
          if (c.type === "document" && c.source?.data) {
            parts.push({
              inline_data: {
                mime_type: "application/pdf",
                data: c.source.data
              }
            });
          }
        });
      }
      contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
    });

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          contents,
          generationConfig: { maxOutputTokens: max_tokens || 4000, temperature: 0.1 }
        })
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    
    // Clean up Gemini's potential markdown formatting
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();

    res.json({ content: [{ type: "text", text }] });
  } catch (err) {
    console.error("Gemini Proxy Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── VAULT ROUTES ──────────────────────────────────────────────────────────────
app.get("/api/vaults", async (req, res) => {
  try {
    const data = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Delimiter: "/" }));
    const vaultList = (data.CommonPrefixes || []).map(p => ({
      id: p.Prefix.replace("/", ""),
      name: p.Prefix.replace("/", "")
    }));
    res.json({ vaults: vaultList }); 
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get("/api/vaults/:id", async (req, res) => {
  try {
    const data = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${req.params.id}/` }));
    const pdfs = (data.Contents || [])
      .filter(f => f.Key.endsWith(".pdf"))
      .map(f => ({ 
        id: f.Key, 
        name: f.Key.replace(`${req.params.id}/`, ""), 
        size: f.Size, 
        key: f.Key 
      }));
    res.json({ pdfs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/vaults/:id/index", async (req, res) => {
  try {
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${req.params.id}/.index.json`,
      Body: JSON.stringify(req.body),
      ContentType: "application/json"
    }));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/vaults/:id/index", async (req, res) => {
  try {
    const data = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${req.params.id}/.index.json` }));
    const body = await streamToBuffer(data.Body);
    res.json(JSON.parse(body.toString()));
  } catch (err) { res.json({ headings: [] }); }
});

// ── PAGE EXTRACTION ──────────────────────────────────────────────────────────
app.post("/api/extract-pages", async (req, res) => {
  const { base64, pages } = req.body;
  try {
    const pdfBytes = Buffer.from(base64, "base64");
    const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    const pageIndices = pages.map(p => p - 1).filter(i => i >= 0 && i < totalPages).sort((a, b) => a - b);
    
    const extractedDoc = await PDFDocument.create();
    const copiedPages = await extractedDoc.copyPages(srcDoc, pageIndices);
    copiedPages.forEach(p => extractedDoc.addPage(p));
    
    const extractedBytes = await extractedDoc.save();
    res.json({ base64: Buffer.from(extractedBytes).toString("base64") });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// END OF FILE - ENSURE THIS LINE IS COPIED
