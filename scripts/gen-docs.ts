import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { BROKER_STRATEGY, GUIDELINES, PORTFOLIO_REVIEW, QUARTERLY, SCANNED_PAGES, type DocPage, type Slide } from "./doc-content.js";

// ---------------------------------------------------------------- minimal PDF writer
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function wrap(text: string, width = 88): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    if ((line + " " + w).trim().length > width) {
      out.push(line);
      line = w;
    } else line = (line + " " + w).trim();
  }
  if (line) out.push(line);
  return out;
}

export function buildPdf(pages: ({ lines: { text: string; size: number; y: number }[] } | { image: true })[]): Buffer {
  const objs: string[] = [];
  const add = (body: string) => objs.push(body) && objs.length;
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const hex = Array.from({ length: 256 }, (_, i) => ((i * 7) % 256).toString(16).padStart(2, "0")).join("") + ">";
  const imageId = add(`<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${hex.length} >>\nstream\n${hex}\nendstream`);
  const pageIds: number[] = [];
  const pagesId = objs.length + 1 + pages.length * 2; // reserved: filled after pages
  for (const p of pages) {
    const content =
      "image" in p
        ? "q 400 0 0 500 100 150 cm /Im1 Do Q"
        : p.lines.map((l) => `BT /F1 ${l.size} Tf 50 ${l.y} Td (${esc(l.text)}) Tj ET`).join("\n");
    const cid = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${cid} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> /XObject << /Im1 ${imageId} 0 R >> >> >>`));
  }
  add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function textPdf(pages: DocPage[], header: string, footerOf: (n: number, total: number) => string): Buffer {
  return buildPdf(
    pages.map((p, i) => {
      const lines = [{ text: header, size: 9, y: 765 }, { text: p.title, size: 16, y: 720 }];
      let y = 690;
      for (const para of p.paragraphs) {
        for (const l of wrap(para)) {
          lines.push({ text: l, size: 11, y });
          y -= 15;
        }
        y -= 8;
      }
      lines.push({ text: footerOf(i + 1, pages.length), size: 9, y: 30 });
      return { lines };
    }),
  );
}

// ---------------------------------------------------------------- minimal PPTX writer (zip of XML)
const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const para = (t: string) => `<a:p><a:r><a:t>${x(t)}</a:t></a:r></a:p>`;

function slideXml(s: Slide): string {
  const table = s.table
    ? `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><a:graphic><a:graphicData><a:tbl>${s.table
        .map((row) => `<a:tr>${row.map((c) => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${x(c)}</a:t></a:r></a:p></a:txBody></a:tc>`).join("")}</a:tr>`)
        .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>${para(s.title)}</p:txBody></p:sp>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>${s.bullets.map(para).join("")}</p:txBody></p:sp>` +
    `${table}</p:spTree></p:cSld></p:sld>`;
}

export function buildPptx(slides: Slide[]): Buffer {
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, xml: string) => (files[path] = strToU8(xml));
  put("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`);
  put("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  // Slide order comes from presentation.xml, not from file names; write rIds in a shuffled-looking but valid order.
  put("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NS}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`);
  put("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`);
  slides.forEach((s, i) => {
    put(`ppt/slides/slide${i + 1}.xml`, slideXml(s));
    const notesRel = s.notes ? `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>` : "";
    put(`ppt/slides/_rels/slide${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${notesRel}</Relationships>`);
    if (s.notes)
      put(`ppt/notesSlides/notesSlide${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><p:notes ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>${para(s.notes)}</p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Slide number"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>${para(String(i + 1))}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`);
  });
  return Buffer.from(zipSync(files));
}

// ---------------------------------------------------------------- entry
export function generateDocs(outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const files: Record<string, Buffer> = {
    "underwriting_guidelines.pdf": textPdf(GUIDELINES, "Northwind Mutual - Underwriting Guidelines - Internal Use", (n, t) => `Page ${n} of ${t}`),
    "quarterly_summary.pdf": textPdf(QUARTERLY, "Northwind Mutual - Quarterly Summary", (n, t) => `Page ${n} of ${t}`),
    "scanned_notes.pdf": buildPdf(Array.from({ length: SCANNED_PAGES }, () => ({ image: true as const }))),
    "portfolio_review.pptx": buildPptx(PORTFOLIO_REVIEW),
    "broker_strategy.pptx": buildPptx(BROKER_STRATEGY),
  };
  for (const [name, buf] of Object.entries(files)) writeFileSync(resolve(outDir, name), buf);
  return Object.keys(files);
}

if (process.argv[1]?.endsWith("gen-docs.ts")) {
  const i = process.argv.indexOf("--out");
  const out = resolve(i >= 0 ? process.argv[i + 1]! : "./sample-data");
  console.log(`Wrote ${generateDocs(out).join(", ")} to ${out}`);
}
