import fs from "fs";
import { IncomingForm } from "formidable";

export const config = {
  api: {
    bodyParser: false,
  },
};

// Check if text is mostly readable
function looksLikeText(text) {
  if (!text || !text.length) return false;

  const printable =
    text.split("").filter(c => c.charCodeAt(0) >= 32).length;

  return printable / text.length > 0.8;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

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
      return res
        .status(400)
        .send('graph TD\nA["No files uploaded"]');
    }

    let combinedText = "";

    for (const fileArr of files) {
      const fileList = Array.isArray(fileArr) ? fileArr : [fileArr];

      for (const f of fileList) {
        // 🔒 ONLY ACCEPT TEXT FILES
        if (!f.originalFilename.toLowerCase().endsWith(".txt")) {
          combinedText += `
=== FILE: ${f.originalFilename} ===
[Unsupported file type. Only OCR-extracted text files are accepted.]
`;
          continue;
        }

        const buffer = await fs.promises.readFile(f.filepath);
        let text = buffer.toString("utf8").trim();

        if (!looksLikeText(text)) {
          combinedText += `
=== FILE: ${f.originalFilename} ===
[File does not appear to contain readable text.]
`;
          continue;
        }

        // 🧠 TOKEN SAFETY (~4k tokens)
        const MAX_CHARS = 15000;
        if (text.length > MAX_CHARS) {
          text = text.slice(0, MAX_CHARS) + "\n[TRUNCATED]";
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
A["No readable text received"]:::document
`);
    }

    // ---------------- Claude Prompt ----------------
    const prompt = `You are a law concept diagram generator.

Given multiple documents, produce a single Mermaid concept map combining all relevant entities, locations, people, and events.

Output MUST start with 'graph TD' or 'graph LR'.

STRICT RULES (DO NOT VIOLATE):
1. Output ONLY valid Mermaid code.
2. Start the output with: graph TD
3. DO NOT include explanations, comments, markdown, or prose.
4. DO NOT create placeholder nodes.
5. DO NOT invent data.
6. EVERY node must represent a REAL entity explicitly found in the documents.

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

ENTITY TYPES TO EXTRACT (only if present):
- Persons
- Organisations
- Locations
- Legal Status
- Events
- Documents

STRUCTURE RULES:
- Use subgraphs for each entity type
- Relationships must be explicit and labeled

IF the documents contain NO extractable legal entities:
Output ONLY:
graph TD
A["No extractable legal entities found"]

Now analyse the following documents and generate the Mermaid diagram.
`;

    console.log("===== CLAUDE INPUT START =====");
    console.log(`${prompt}\n\nDOCUMENTS:\n${combinedText}`);
    console.log("===== CLAUDE INPUT END =====");

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
          {
            role: "user",
            content: `${prompt}\n\nDOCUMENTS:\n${combinedText}`,
          },
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
    res
      .status(500)
      .send('graph TD\nA["Server error – see logs"]');
  }
}
