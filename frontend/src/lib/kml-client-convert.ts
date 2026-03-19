import type { ClientConvertRequestBody } from "@/lib/convert";
import type { KmlWorkerRequest, KmlWorkerResponse } from "@/lib/kml-client-convert-core";
import { buildClientConvertRequestFromKmlText } from "@/lib/kml-client-convert-core";

const WORKER_TIMEOUT_MS = 45000;

function toReadableErrorMessage(value: unknown, fallback: string): string {
  const isObjectObjectText = (text: string) => text.trim() === "[object Object]";

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || isObjectObjectText(trimmed)) {
      return fallback;
    }
    return trimmed;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const nested = toReadableErrorMessage(obj.message ?? obj.detail ?? obj.error ?? obj.cause, "");
    if (nested) {
      return nested;
    }
    try {
      const serialized = JSON.stringify(obj);
      return serialized || fallback;
    } catch {
      return fallback;
    }
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export async function convertKmlFileInBrowser(file: File): Promise<ClientConvertRequestBody> {
  const text = await file.text();
  try {
    return await parseWithWorker(text, file.name);
  } catch {
    return buildClientConvertRequestFromKmlText(text, file.name);
  }
}

async function parseWithWorker(text: string, filename: string): Promise<ClientConvertRequestBody> {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    throw new Error("worker unavailable");
  }

  const worker = new Worker(new URL("../workers/kml-parse.worker.ts", import.meta.url), { type: "module" });
  const payload: KmlWorkerRequest = {
    type: "parse",
    filename,
    text,
  };

  return new Promise<ClientConvertRequestBody>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("KML parsing timed out."));
    }, WORKER_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<KmlWorkerResponse>) => {
      const message = event.data;
      cleanup();
      if (!message) {
        reject(new Error("Worker returned an empty payload."));
        return;
      }
      if (message.type === "success") {
        resolve(message.payload);
        return;
      }
      reject(new Error(toReadableErrorMessage(message.message, "KML conversion failed in worker.")));
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(toReadableErrorMessage(event.message, "Worker execution failed.")));
    };

    worker.postMessage(payload);

    function cleanup() {
      window.clearTimeout(timer);
      worker.terminate();
    }
  });
}
