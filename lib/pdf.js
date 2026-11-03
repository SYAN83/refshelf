import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Extract text from a PDF buffer. `maxPages` limits how far we read (null = all). */
export async function pdfText(buf, maxPages = null) {
  const doc = await getDocument({ data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const n = maxPages ? Math.min(maxPages, doc.numPages) : doc.numPages;
    const pages = [];
    for (let i = 1; i <= n; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      pages.push(content.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join(""));
    }
    const { info } = await doc.getMetadata().catch(() => ({ info: {} }));
    return { text: pages.join("\n\n"), numPages: doc.numPages, info: info ?? {} };
  } finally {
    await doc.destroy();
  }
}
