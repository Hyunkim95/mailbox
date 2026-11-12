import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { MerchantError } from "@mailbox/service-sdk";
import type { AppStore } from "./app-store.ts";
import type { AgentDocument } from "./app-model.ts";

export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;
const MAX_TEXT = 100_000;
export async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  limit = MAX_DOCUMENT_BYTES,
): Promise<Uint8Array> {
  if (!stream)
    throw new MerchantError("DOCUMENT_EMPTY", "The document is empty.");
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > limit) {
        await reader.cancel();
        throw new MerchantError(
          "DOCUMENT_SIZE",
          "The document exceeds the size limit.",
        );
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Untrusted PDFs parse in a disposable worker with memory and time bounds. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `const {parentPort,workerData}=require('node:worker_threads');
   (async()=>{const {getDocumentProxy,extractText}=await import('unpdf');
    const pdf=await getDocumentProxy(new Uint8Array(workerData),{isEvalSupported:false,maxImageSize:0,useSystemFonts:true,useWorkerFetch:false,verbosity:0});
    try{if(pdf.numPages>30)throw Error('This PDF exceeds the 30-page limit.');
      const {text}=await extractText(pdf,{mergePages:true});parentPort.postMessage({text:text.slice(0,100001)});
    }finally{await pdf.destroy()}
   })().catch(()=>parentPort.postMessage({error:'This PDF could not be read. It may be encrypted, scanned or unsupported.'}));`,
      {
        eval: true,
        workerData: bytes,
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
        },
      },
    );
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(Error("Document reading timed out."));
    }, 10000);
    worker.once("message", (value: { text?: string; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      value.error ? reject(Error(value.error)) : resolve(value.text ?? "");
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(Error("Document reading stopped before completion."));
    });
  });
}

export async function importDocument(
  store: AppStore,
  owner: string,
  agentId: string,
  input: {
    filename: string;
    content_type: string;
    bytes: Uint8Array;
    message_id?: string;
    origin?: AgentDocument["origin"];
  },
): Promise<AgentDocument> {
  store.agent(owner, agentId);
  if (!input.bytes.length || input.bytes.length > MAX_DOCUMENT_BYTES)
    throw new MerchantError(
      "DOCUMENT_SIZE",
      "Choose a nonempty document of up to 3 MB.",
    );
  if (
    input.message_id &&
    !store
      .messages(owner)
      .some((m) => m.id === input.message_id && m.agent_id === agentId)
  )
    throw new MerchantError(
      "NOT_FOUND",
      "The source email is not in this agent's inbox.",
    );
  const filename =
    input.filename.replace(/[\r\n/\\]/g, "_").slice(0, 180) || "document";
  const type = input.content_type.toLowerCase().split(";")[0]!;
  const id = `document:${createHash("sha256")
    .update(owner)
    .update(agentId)
    .update(input.message_id ?? "")
    .update(filename)
    .update(input.bytes)
    .digest("hex")}`;
  const previous = store.documents(owner, agentId).find((d) => d.id === id);
  if (previous) return previous;
  let text = "",
    limitation: string | null = null;
  try {
    if (type === "application/pdf" || filename.toLowerCase().endsWith(".pdf"))
      text = await pdfText(input.bytes);
    else if (type.startsWith("text/") || /\.(txt|csv|md|json)$/i.test(filename))
      text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    else
      limitation =
        "This file type is not readable yet. Use a text-based PDF or text document.";
    if (!text.trim() && !limitation)
      limitation =
        "No readable text was found. Scanned documents need OCR before they can be used as evidence.";
  } catch (error) {
    limitation =
      error instanceof Error
        ? error.message
        : "This document could not be read.";
  }
  const doc: AgentDocument = {
    id,
    agent_id: agentId,
    message_id: input.message_id ?? null,
    filename,
    content_type: type,
    size: input.bytes.length,
    text: text.slice(0, MAX_TEXT),
    truncated: text.length > MAX_TEXT,
    status: limitation ? "unread" : "readable",
    limitation,
    created_at: store.now().toISOString(),
    origin: input.origin ?? "upload",
  };
  store.saveDocument(owner, doc, input.bytes);
  store.log(
    owner,
    "DOCUMENT_ADDED",
    `${filename}${limitation ? ": reading incomplete" : " is ready to search"}`,
    null,
    null,
    agentId,
  );
  return doc;
}
