import fs from "fs";
import path from "path";
import { IncomingForm } from "formidable";
import Tesseract from "tesseract.js-node";
import { fromPath } from "pdf2pic";

export const config = {
  api: { bodyParser: false },
};

// Utility to check if text is mostly readable
function looksLikeText(text) {
  const printableRatio =
    text.split("").filter((c) => c.charCodeAt(0) >= 32).length / text.length;
  return printableRatio > 0.8;
}

// Supported file types
function isSupported(file) {
  const ext = path.extname(file.originalFilename).toLowerCase();
  return [".pdf", ".txt"].includes(ext);
}

// OCR a PNG/JPG image using Tesseract
async function ocrImage(imagePath) {
  try {
    const { data: { text } } = await Tesseract.recognize(imagePath, "eng");
    return text || "";
  } catch (err) {
    console.warn("⚠️ OCR failed for image:", imagePath, err);
    return "";
  }
}

// Convert PDF to images and OCR each page
async function ocrPdf(pdfPath) {
  const converter = fromPath(pdfPath, {
    density: 150,
    format: "png",
    width: 1200,
    height: 1600,
    savePath: "/tmp",
  });

  const pageCount = 50; // safety limit
  let fullText = "";

  for (let i = 1; i <= pageCount; i++) {
    try {
      const pageFile = await converter(i, true); // returns { path: '...' }
      if (!pageFile?.path || !fs.existsSync(pageFile.path)) break;

      const pageText = await ocrImage(pageFile.path);
      fullText += pageText + "\n";

      // Clean up temp image
      fs.unlinkSync(pageFile.path);
    } catch {
      break; // no more pages
    }
  }

  return fullText;
}

// --- API handler ---
export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).send("Method Not Allowed");

  try {
    // Parse multipart/form-data
    const form = new IncomingForm({ keepExtensions: true });
    const files = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve(Object.values(files));
      });
    });

    if (!files.length) {
      return res.status(400).send('graph TD\nA["No files uploaded"]');
    }

    let combinedText = "";

    for (const fileArr of files) {
      const fileList = Array.isArray(fileArr) ? fileArr : [fileArr];

      for (const f of fileList) {
        if (!isSupported(f)) {
          combinedText += `
=== FILE: ${f.originalFilename} ===
[Unsupported file type. Only PDF or TXT documents are processed.]
`;
          continue;
        }

        const ext = path.extname(f.originalFilename).toLowerCase();
        let text = "";

        if (ext === ".txt") {
          text = (await fs.promises.readFile(f.filepath, "utf8")) || "";
        } else if (ext === ".pdf") {
          console.log("📄 OCR-ing PDF:", f.originalFilename);
          text = await ocrPdf(f.filepath);
        }

        // Clean text
        text = text.replace(/\s+/g, " ").replace(/[^\x20-\x7E]/g, "").trim();

        const MAX_CHARS = 15000;
        if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + "\n[TRUNCATED]";

        if (!text) {
          combinedText += `
=== FILE: ${f.originalFilename} ===
[No extractable text found.]
`;
          continue;
        }

        combinedText += `
=== FILE: ${f.originalFilename} ===
${text}
`;
      }
    }

    if (!combinedText.trim()) {
      return res.send(`
graph TD
A["Some files could not be processed"]:::document
B["Scanned or image-based documents require OCR"]:::legal_issue
A --> B
`);
    }

    // --- Claude prompt ---
    const prompt = `You are a law concept diagram generator.

Given multiple documents, produce a single Mermaid concept map combining all relevant entities, locations, people, and events.

Output MUST start with 'graph TD' or 'graph LR'.

STRICT RULES (DO NOT VIOLATE):
1. Output ONLY valid Mermaid code.
2. Start the output with: graph TD
3. Do NOT include explanations, comments, markdown, or prose.
4. Do NOT create placeholder nodes (e.g. "Persons", "Organisations", "Legal Issues").
5. Do NOT invent data.
6. Do NOT output a section unless the document contains real, extractable entities.
7. EVERY node must represent a REAL entity explicitly found in the document.

MANDATORY STYLING RULES:
- Assign Mermaid classes to every node using :::className
- Use ONLY the following classes:

case
person
organisation
legal_issue
event
document
location

- Do NOT invent new classes.

ENTITY TYPES TO EXTRACT (only if present):
- Persons (directors, shareholders, officers)
- Organisations (companies, authorities)
- Locations (addresses, registered offices)
- Legal Status (e.g. Struck Off, Active)
- Events (appointments, filings, strike-off)
- Documents (Bizfile, ACRA filings)

STRUCTURE RULES:
- Use subgraphs for each entity type.
- Node labels must contain real names + key attributes.
- Relationships must be explicit and labeled.

EXAMPLE NODE FORMAT:
PERSON_ALAN["ALAN YEO KENG HUA<br/>NRIC: S1735082Z<br/>Role: Director"]
ORG_ARM["ASIA RESOURCES MANAGEMENT PTE LTD<br/>UEN: 200804657Z<br/>Status: Struck Off"]

RELATIONSHIP EXAMPLES:
PERSON_ALAN -->|Director| ORG_ARM
ORG_ARM -.->|Registered Address| LOC_GOLDHILL

IF the document contains NO extractable legal entities:
Output ONLY:
graph TD
A["No extractable legal entities found"]

Now analyse the following document and generate the Mermaid diagram.
`;

    console.log("===== CLAUDE INPUT START =====");
    console.log(`${prompt}\n\nDOCUMENTS:\n${combinedText}`);
    console.log("===== CLAUDE INPUT END =====");

    // --- Call Claude API ---
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [
          { role: "user", content: `${prompt}\n\nDOCUMENTS:\n${combinedText}` },
        ],
      }),
    });

    const data = await response.json();

    console.log("===== CLAUDE RAW RESPONSE =====");
    console.log(JSON.stringify(data, null, 2));
    console.log("===== END CLAUDE RAW RESPONSE =====");

    const rawText = data.content?.[0]?.text || "";
    const match = rawText.match(/(graph\s+(TD|LR)[\s\S]*)/);
    const mermaidCode = match
      ? match[1].trim()
      : 'graph TD\nA["No valid Mermaid diagram returned"]';

    res.send(mermaidCode);
  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).send('graph TD\nA["Server error – see logs"]');
  }
}
