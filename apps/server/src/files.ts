import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact } from "../../../packages/domain/src/index.ts";
import { fillPdf, inspectPdf } from "../../../packages/integrations/src/pdf.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

/** Content-derived id for computer workspace PDF exports: a retried export of
 * identical bytes lands on the same file row instead of duplicating it, while
 * genuinely changed content still mints a new row. */
export function computerExportId(path: string, bytes: Uint8Array): string {
  const content = createHash("sha256").update(bytes).digest("hex");
  return createHash("sha256")
    .update(JSON.stringify(["computer-export", path, content]))
    .digest("hex");
}

export class Files {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly auth: Auth,
  ) {}
  async import(
    owner: string,
    name: string,
    bytes: Uint8Array,
    source: string,
    parentId?: string,
    id?: string,
  ): Promise<Artifact> {
    if (bytes.length > 10 * 1024 * 1024) throw new AppError("PDFs must be 10 MB or smaller", 413);
    const metadata = await inspectPdf(bytes);
    if (metadata.pageCount > 500) throw new AppError("PDFs must have 500 pages or fewer", 422);
    const fileId = id ?? randomUUID();
    const safeName = Array.from(name.split(/[\\/]/).at(-1) ?? "document.pdf")
      .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
      .join("")
      .slice(0, 180);
    const artifact: Artifact = {
      id: fileId,
      name: safeName,
      mimeType: "application/pdf",
      size: bytes.length,
      pageCount: metadata.pageCount,
      fields: metadata.fields,
      url: "",
      createdAt: new Date().toISOString(),
      source,
      parentId,
    };
    const directory = join(this.config.dataDir, "files");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filePath = join(directory, `${fileId}.pdf`);
    try {
      await writeFile(filePath, bytes, { mode: 0o600, flag: "wx" });
    } catch (error) {
      // A concurrent or retried import with the same explicit id lands here.
      // Identical bytes mean the first write won: reuse its row. Differing
      // bytes under one id is a caller bug, so fail loud instead of aliasing.
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const onDisk = await readFile(filePath);
      if (!onDisk.equals(Buffer.from(bytes))) {
        throw new AppError("Conflicting upload for the same file id", 500);
      }
      const existing = await this.db.get<Artifact>(owner, "files", fileId);
      if (existing) return this.signed(owner, existing);
      // The disk write landed but the row never did (crash between the two):
      // fall through and heal the row below.
    }
    await this.db.put(owner, "files", artifact);
    return this.signed(owner, artifact);
  }
  signed(owner: string, file: Artifact): Artifact {
    return { ...file, url: this.auth.sign(owner, `/api/files/${file.id}/content`) };
  }
  async list(owner: string) {
    return (await this.db.list<Artifact>(owner, "files")).map((file) => this.signed(owner, file));
  }
  async get(owner: string, id: string) {
    const file = await this.db.get<Artifact>(owner, "files", id);
    if (!file) throw new AppError("File not found", 404);
    return file;
  }
  async bytes(owner: string, id: string) {
    await this.get(owner, id);
    return readFile(join(this.config.dataDir, "files", `${id}.pdf`));
  }
  async fill(owner: string, id: string, values: Record<string, string | boolean>) {
    const file = await this.get(owner, id);
    const bytes = await this.bytes(owner, id);
    const output = await fillPdf(bytes, values);
    return this.import(
      owner,
      `${file.name.replace(/\.pdf$/i, "")} — filled.pdf`,
      output,
      `Filled from ${file.name}`,
      id,
    );
  }
}
