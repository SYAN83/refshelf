import Anthropic from "@anthropic-ai/sdk";
import { pdfText } from "./pdf.js";

const client = new Anthropic();

const MAX_PDF_BYTES = 30 * 1024 * 1024; // API request limit is 32 MB including base64 overhead headroom
const MAX_PDF_PAGES = 600;

const SYSTEM = `You summarize academic sources for a researcher's personal reference library.
Write in Markdown with exactly these sections:

## TL;DR
One or two sentences: what the work does and its main result.

## Research question
## Approach
## Key findings
Bulleted, concrete — include the numbers that matter.
## Limitations
Stated by the authors or evident from the work.
## When to cite this
The kinds of claims in someone else's paper this source would support.

Be precise and faithful to the source; do not invent results. If the document is not a research paper, adapt the sections sensibly.`;

function describe(ref) {
  const authors = ref.authors.map((a) => [a.given, a.family].filter(Boolean).join(" ")).join(", ");
  return [`Title: ${ref.title}`, authors && `Authors: ${authors}`, ref.year && `Year: ${ref.year}`, ref.venue && `Venue: ${ref.venue}`]
    .filter(Boolean)
    .join("\n");
}

/** Summarize a reference. `pdf` is a Buffer or null. Returns markdown. */
export async function summarize(ref, pdf) {
  const content = [];
  if (pdf) {
    const { numPages } = await pdfText(pdf, 1);
    if (pdf.length <= MAX_PDF_BYTES && numPages <= MAX_PDF_PAGES) {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } });
    } else {
      // Too large to send as a PDF document — send the full extracted text instead.
      const { text } = await pdfText(pdf);
      content.push({ type: "text", text: `<document>\n${text}\n</document>` });
    }
    content.push({ type: "text", text: `${describe(ref)}\n\nSummarize this document.` });
  } else if (ref.abstract) {
    content.push({
      type: "text",
      text: `${describe(ref)}\n\nAbstract:\n${ref.abstract}\n\nOnly the abstract is available (no full text). Summarize it, and note at the top that the summary is based on the abstract alone.`,
    });
  } else {
    throw new Error("Nothing to summarize: attach a PDF or add an abstract first.");
  }

  const message = await client.beta.messages
    .stream({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      output_config: { effort: "medium" },
      system: SYSTEM,
      messages: [{ role: "user", content }],
      // On a safety-classifier decline, the API re-runs the request on a recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    })
    .finalMessage()
    .catch((err) => {
      if (err instanceof Anthropic.AuthenticationError || /authentication method/i.test(err.message)) {
        throw new Error("No Anthropic credentials: start RefShelf with ANTHROPIC_API_KEY set to enable summaries.");
      }
      throw err;
    });

  if (message.stop_reason === "refusal") {
    throw new Error(`Claude declined to summarize this document${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : "."}`);
  }
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) throw new Error(`Empty summary (stop_reason: ${message.stop_reason})`);
  return text;
}
