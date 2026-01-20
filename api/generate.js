import fs from "fs";
import { IncomingForm } from "formidable";

export const config = {
  api: { bodyParser: false },
};

// ---------- Utility: check if buffer looks like readable text ----------
function looksLikeText(text) {
  if (!text) return false;
  const printableRatio =
    text.split("").filter((c) => c.charCodeAt(0) >= 32).length / text.length;
  return printableRatio > 0.8;
}

// ---------- Helper: call Claude ----------
async function callClaude(prompt) {
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
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();

  console.log("===== CLAUDE RAW RESPONSE =====");
  console.log(JSON.stringify(data, null, 2));
  console.log("===== END CLAUDE RAW RESPONSE =====");

  const rawText = data.content?.[0]?.text || "";
  const match = rawText.match(/(graph\s+(TD|LR)[\s\S]*)/);

  return match
    ? match[1].trim()
    : 'graph TD\nA["No extractable legal entities found"]';
}

// ---------- API handler ----------
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

    // Store merged diagram body (no repeated graph TD)
    let mergedBody = "";
    const seenLines = new Set();

    // ----- Process each uploaded file individually -----
    for (const fileArr of files) {
      const fileList = Array.isArray(fileArr) ? fileArr : [fileArr];

      for (const f of fileList) {
        console.log("📄 Processing file:", f.originalFilename);

        const buffer = await fs.promises.readFile(f.filepath);
        const content = buffer.toString("utf8");

        if (!looksLikeText(content)) {
          console.warn("⚠️ Non-text or scanned file skipped:", f.originalFilename);
          continue;
        }

        // ---------- Claude prompt ----------
        const prompt = `You are a law concept diagram generator.

Given a document, generate a Mermaid concept diagram.

Output MUST start with 'graph TD' or 'graph LR'.

STRICT RULES:
1. Output ONLY valid Mermaid code.
2. Start with: graph TD
3. NO explanations, comments, or markdown.
4. DO NOT invent data.
5. EVERY node must be a real entity from the document.
6. Assign Mermaid classes using :::className.

ALLOWED CLASSES:
case
person
organisation
legal_issue
event
document
location

STRUCTURE RULES:
- Use subgraphs per entity type.
- Node labels must include real names and attributes.
- Relationships must be explicit and labeled.

EXAMPLE:
PERSON_A["ALAN YEO KENG HUA<br/>Role: Director"]:::person
ORG_X["ASIA RESOURCES MANAGEMENT PTE LTD<br/>Status: Struck Off"]:::organisation
PERSON_A -->|Director| ORG_X

IF no entities exist:
graph TD
A["No extractable legal entities found"]

DOCUMENT:
${content}
`;

        const partialDiagram = await callClaude(prompt);

        // Remove repeated "graph TD"
        const body = partialDiagram.replace(/^graph\s+(TD|LR)\s*/i, "");

        body.split("\n").forEach((line) => {
          const clean = line.trim();
          if (clean && !seenLines.has(clean)) {
            seenLines.add(clean);
            mergedBody += clean + "\n";
          }
        });
      }
    }

    // ---------- Mermaid class styling (matches your legend) ----------
    const CLASS_STYLES = `
classDef case fill:#fef3c7,stroke:#92400e,stroke-width:1px,color:#000;
classDef person fill:#e0f2fe,stroke:#0369a1,stroke-width:1px,color:#000;
classDef organisation fill:#dcfce7,stroke:#166534,stroke-width:1px,color:#000;
classDef legal_issue fill:#fee2e2,stroke:#991b1b,stroke-width:1px,color:#000;
classDef event fill:#ede9fe,stroke:#5b21b6,stroke-width:1px,color:#000;
classDef document fill:#f1f5f9,stroke:#334155,stroke-width:1px,color:#000;
classDef location fill:#fff7ed,stroke:#9a3412,stroke-width:1px,color:#000;
`;

    let finalDiagram = "graph TD\n" + CLASS_STYLES + "\n";

    if (mergedBody.trim()) {
      finalDiagram += mergedBody;
    } else {
      finalDiagram += 'A["No extractable legal entities found"]';
    }

    res.send(finalDiagram);
  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).send('graph TD\nA["Server error – see logs"]');
  }
}
