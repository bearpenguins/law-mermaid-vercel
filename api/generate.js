import fs from "fs";
import { IncomingForm } from "formidable";

export const config = {
  api: {
    bodyParser: false
  }
};

function looksLikeText(text) {
  const printableRatio =
    text.split("").filter(c => c.charCodeAt(0) >= 32).length / text.length;

  return printableRatio > 0.8;
}


export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    // Parse multipart/form-data in memory
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
      // fileArr may be an array if multiple uploads per input name
      const fileList = Array.isArray(fileArr) ? fileArr : [fileArr];
      for (const f of fileList) {
        const buffer = await fs.promises.readFile(f.filepath);
        const content = buffer.toString("utf8");

        if (!looksLikeText(content)) {
          console.warn("⚠️ Non-text file detected:", f.originalFilename);

          combinedText += `
      === FILE: ${f.originalFilename} ===
      [WARNING: This file appears to be scanned or image-based and could not be read as text.]
      `;
          continue;
        }

        combinedText += `
      === FILE: ${f.originalFilename} ===
      ${content}
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


    const prompt = `You are a law concept diagram generator.

    Your task is to analyse one or more legal documents and produce a single, unified Mermaid concept diagram.

    ────────────────────────────────
    OUTPUT FORMAT (STRICT)
    ────────────────────────────────
    1. Output ONLY valid Mermaid code.
    2. Output raw Mermaid syntax only — NO markdown fences, NO triple backticks, NO backticks.
    3. Output MUST begin with either:
      - graph TD
      - graph LR
    4. Include a Mermaid title using the official syntax:

      ---
      title: <Short descriptive title inferred from the documents>
      ---

    5. Do NOT include explanations, markdown, comments, or prose.
    6. Do NOT invent or assume any facts.
    7. Every node MUST represent a real, explicitly stated entity in the document(s).

    ────────────────────────────────
    ENTITY & CONTENT RULES
    ────────────────────────────────
    - Extract entities ONLY if they are explicitly present.
    - Allowed entity types:
      - case
      - person
      - organisation
      - legal_issue
      - event
      - document
      - location

    - Do NOT invent new classes.
    - Do NOT create empty or placeholder sections.

    If an entity type is not present, it MUST NOT appear in the diagram.

    ────────────────────────────────
    STRUCTURE RULES
    ────────────────────────────────
    - Use subgraphs ONLY when they contain at least one real entity.
    - Subgraph titles must reflect the entity type (e.g. Persons, Organisations).
    - Node labels must include real names and relevant attributes only.
    - Relationships must be explicit and labeled.

    ────────────────────────────────
    STYLING RULES (MANDATORY)
    ────────────────────────────────
    - Every node MUST include a Mermaid class using :::className
    - Use only the approved classes listed above.

    ────────────────────────────────
    MERMAID STRUCTURE EXAMPLE (FORMAT ONLY)
    ────────────────────────────────
    The following is a structural example ONLY.
    Do NOT copy names, entities, or relationships from it.

    graph TD
    ---
    title: Example Legal Concept Map
    ---

    subgraph Organisations
      ORG_X["Company Name<br/>UEN: XXXXXXXX<br/>Status: Active"]:::organisation
    end

    subgraph Persons
      PERSON_Y["Person Name<br/>Role: Director"]:::person
    end

    PERSON_Y -->|Director| ORG_X

    ────────────────────────────────
    EMPTY DOCUMENT RULE
    ────────────────────────────────
    If NO extractable legal entities exist, output ONLY:

    graph TD
    ---
    title: No Extractable Legal Entities
    ---
    A["No extractable legal entities found"]:::document

    ────────────────────────────────
    TASK
    ────────────────────────────────
    Now analyse the following document(s) and generate the Mermaid diagram.
    `;

    console.log("===== CLAUDE INPUT START =====");
    console.log(`${prompt}\n\nDOCUMENTS:\n${combinedText}`);
    console.log("===== CLAUDE INPUT END =====");


    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{ role: "user", content: `${prompt}\n\nDOCUMENTS:\n${combinedText}` }]
      })
    });

    const data = await response.json();

    console.log("===== CLAUDE RAW RESPONSE =====");
    console.log(JSON.stringify(data, null, 2));
    console.log("===== END CLAUDE RAW RESPONSE =====");

    let rawText = data.content?.[0]?.text || "";
    rawText = rawText
      .replace(/^```mermaid\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    const match = rawText.match(/(graph\s+(TD|LR)[\s\S]*)/);
    const mermaidCode = match ? match[1].trim() : 'graph TD\nA["No valid Mermaid diagram returned"]';

    res.send(mermaidCode);

  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).send('graph TD\nA["Server error – see logs"]');
  }
}
