import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

export interface SlideText {
  slide: number;
  title: string;
  /** title + body + table cell text + "Notes: ..." */
  text: string;
}

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: false });

type Node = Record<string, unknown>;
const attrs = (n: Node) => (n[":@"] as Record<string, string> | undefined) ?? {};
const tagOf = (n: Node) => Object.keys(n).find((k) => k !== ":@");

function collectText(nodes: Node[]): string {
  let s = "";
  for (const n of nodes) {
    const key = tagOf(n);
    if (!key) continue;
    const kids = n[key] as Node[];
    if (key === "a:t") s += (kids as unknown as { "#text"?: string }[]).map((k) => k["#text"] ?? "").join("");
    else if (key === "a:br") s += " ";
    else if (Array.isArray(kids)) s += collectText(kids);
  }
  return s;
}

function findAll(nodes: Node[], tag: string, out: Node[] = []): Node[] {
  for (const n of nodes) {
    const key = tagOf(n);
    if (!key) continue;
    if (key === tag) out.push(n);
    const kids = n[key];
    if (Array.isArray(kids)) findAll(kids as Node[], tag, out);
  }
  return out;
}

/** Paragraph texts (a:p) in document order. Shapes whose placeholder type is in `skip` are ignored. */
function paragraphs(nodes: Node[], skip: Set<string> = new Set(), out: string[] = []): string[] {
  for (const n of nodes) {
    const key = tagOf(n);
    if (!key) continue;
    const kids = n[key] as Node[];
    if (key === "a:p") {
      const t = collectText(kids).replace(/\s+/g, " ").trim();
      if (t) out.push(t);
    } else if (key === "p:sp" && skip.size && findAll(kids, "p:ph").some((ph) => skip.has(attrs(ph)["@_type"] ?? ""))) {
      continue;
    } else if (Array.isArray(kids)) {
      paragraphs(kids, skip, out);
    }
  }
  return out;
}

const isTitle = (spKids: Node[]) =>
  findAll(spKids, "p:ph").some((ph) => ["title", "ctrTitle"].includes(attrs(ph)["@_type"] ?? ""));

function relMap(xml: string): Map<string, { target: string; type: string }> {
  const m = new Map<string, { target: string; type: string }>();
  for (const r of findAll(parser.parse(xml) as Node[], "Relationship")) {
    const a = attrs(r);
    if (a["@_Id"]) m.set(a["@_Id"], { target: a["@_Target"] ?? "", type: a["@_Type"] ?? "" });
  }
  return m;
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
function resolvePath(base: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : dirOf(base) + target).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== ".") out.push(p);
  }
  return out.join("/");
}

/** One unit per slide, in the order given by ppt/presentation.xml. */
export async function extractPptxSlides(path: string): Promise<SlideText[]> {
  const files = unzipSync(new Uint8Array(await readFile(path)));
  const read = (p: string) => (files[p] ? strFromU8(files[p]!) : null);
  const pres = read("ppt/presentation.xml");
  const presRels = read("ppt/_rels/presentation.xml.rels");
  if (!pres || !presRels) throw new Error("Not a valid PPTX (presentation.xml is missing).");
  const rels = relMap(presRels);
  const order = findAll(parser.parse(pres) as Node[], "p:sldId")
    .map((n) => attrs(n)["@_r:id"])
    .filter((x): x is string => !!x);

  const out: SlideText[] = [];
  for (const [i, rid] of order.entries()) {
    const rel = rels.get(rid);
    if (!rel) continue;
    const slidePath = resolvePath("ppt/presentation.xml", rel.target);
    const xml = read(slidePath);
    if (!xml) continue;
    const tree = parser.parse(xml) as Node[];
    const shapes = findAll(tree, "p:sp").map((sp) => sp["p:sp"] as Node[]);
    const title = shapes.filter(isTitle).flatMap((sp) => paragraphs(sp)).join(" ").trim();
    const body = shapes.filter((sp) => !isTitle(sp)).flatMap((sp) => paragraphs(sp));
    const tables = findAll(tree, "a:tbl").flatMap((t) =>
      findAll(t["a:tbl"] as Node[], "a:tr").map((tr) =>
        findAll(tr["a:tr"] as Node[], "a:tc")
          .map((tc) => paragraphs(tc["a:tc"] as Node[]).join(" "))
          .join(" | "),
      ),
    );

    let notes = "";
    const relsXml = read(`${dirOf(slidePath)}_rels/${slidePath.slice(slidePath.lastIndexOf("/") + 1)}.rels`);
    if (relsXml) {
      for (const r of relMap(relsXml).values()) {
        if (!r.type.endsWith("/notesSlide")) continue;
        const nx = read(resolvePath(slidePath, r.target));
        if (nx) notes = paragraphs(parser.parse(nx) as Node[], new Set(["sldNum", "hdr", "ftr", "dt"])).join(" ");
      }
    }
    const parts = [title, ...body, ...tables, notes ? `Notes: ${notes}` : ""].filter(Boolean);
    out.push({ slide: i + 1, title, text: parts.join("\n") });
  }
  return out;
}
