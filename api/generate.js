import fs from "fs";
import { IncomingForm } from "formidable";

export const config = {
  api: { bodyParser: false },
};

// Utility: check if text is mostly readable
function looksLikeText(text) {
  const printableRatio =
    text.split("").filter((c) => c.charCodeAt(0) >= 32).length / text.length;
  return printableRatio > 0.8;
}

// Helper: call Claude API
async function callClaude(prompt, filename) {
  console.log(`Calling Claude for file: ${filename}`);
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
  // Extract only the graph TD / LR portion
  const match = rawText.match(/graph\s+(TD|LR)[\s\S]*/i);
  return match ? match[0].trim() : "";
}

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

    // --- Final diagram initialization with class styles ---
    let finalDiagram = `graph TD
  classDef case fill:#fef3c7,stroke:#92400e,stroke-width:1px,color:#000;
  classDef person fill:#e0f2fe,stroke:#0369a1,stroke-width:1px,color:#000;
  classDef organisation fill:#dcfce7,stroke:#166534,stroke-width:1px,color:#000;
  classDef legal_issue fill:#fee2e2,stroke:#991b1b,stroke-width:1px,color:#000;
  classDef event fill:#ede9fe,stroke:#5b21b6,stroke-width:1px,color:#000;
  classDef document fill:#f1f5f9,stroke:#334155,stroke-width:1px,color:#000;
  classDef location fill:#fff7ed,stroke:#9a3412,stroke-width:1px,color:#000;
`;

    // --- Process each file individually ---
    for (const fileArr of files) {
      const fileList = Array.isArray(fileArr) ? fileArr : [fileArr];

      for (const f of fileList) {
        const buffer = await fs.promises.readFile(f.filepath);
        const content = buffer.toString("utf8");

        if (!looksLikeText(content)) {
          console.warn("⚠️ Non-text file detected:", f.originalFilename);
          continue;
        }

        // Construct the prompt for Claude
        const prompt = `You are a law concept diagram generator.

      Given multiple documents, produce a single Mermaid concept map combining all relevant entities, locations, people, and events.

      Output MUST start with 'graph TD' or 'graph LR'.

      STRICT RULES (DO NOT VIOLATE):
      1. Output ONLY valid Mermaid code.
      2. Start the output with: graph TD
      3. DO NOT include explanations, comments, markdown, or prose.
      4. DO NOT create placeholder nodes (e.g. "Persons", "Organisations", "Legal Issues").
      5. DO NOT invent data.
      6. DO NOT output a section unless the document contains real, extractable entities.
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
          
    DOCUMENT:

    === FILE: ${f.originalFilename} ===
    ${content}
      `

        const partialDiagram = await callClaude(prompt, f.originalFilename);

        // Append partial diagram, removing its own graph TD
        const body = partialDiagram.replace(/graph\s+(TD|LR)/i, "").trim();
        if (body) finalDiagram += "\n" + body + "\n";
      }
    }

    if (!finalDiagram.trim() || finalDiagram === "graph TD") {
      finalDiagram += 'A["No extractable legal entities found"]';
    }

    res.send(finalDiagram);
  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).send('graph TD\nA["Server error – see logs"]');
  }
}
