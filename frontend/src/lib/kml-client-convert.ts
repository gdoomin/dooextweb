import type { ClientConvertRequestBody, KmzVisualPayload } from "@/lib/convert";
import type { KmlWorkerRequest, KmlWorkerResponse } from "@/lib/kml-client-convert-core";
import { buildClientConvertRequestFromKmlText } from "@/lib/kml-client-convert-core";
import { extractKmzForConversion } from "@/lib/kmz-client-extract";
import { convertNonKmlFileInBrowser, type NonKmlSourceFormat } from "@/lib/nonkml-client-convert";

const WORKER_TIMEOUT_MS = 45000;

type SourceFormat = "kml" | "kmz" | NonKmlSourceFormat;

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

function detectSourceFormat(file: File): SourceFormat {
  const lowerName = String(file.name || "").trim().toLowerCase();
  if (lowerName.endsWith(".kmz")) {
    return "kmz";
  }
  if (lowerName.endsWith(".kml")) {
    return "kml";
  }
  if (lowerName.endsWith(".gpx")) {
    return "gpx";
  }
  if (lowerName.endsWith(".geojson") || lowerName.endsWith(".json")) {
    return "geojson";
  }
  if (lowerName.endsWith(".csv")) {
    return "csv";
  }
  if (lowerName.endsWith(".txt")) {
    return "txt";
  }
  throw new Error("지원하지 않는 파일 형식입니다. KML/KMZ/GPX/GeoJSON/CSV/TXT 파일만 업로드해 주세요.");
}

function hasKmzVisualData(visual: KmzVisualPayload): boolean {
  const overlayCount = Array.isArray(visual.ground_overlays) ? visual.ground_overlays.length : 0;
  const markerCount = Array.isArray(visual.point_markers) ? visual.point_markers.length : 0;
  return overlayCount > 0 || markerCount > 0;
}

function attachSourceMetadata(
  parsed: ClientConvertRequestBody,
  sourceFormat: SourceFormat,
  sourceHash: string,
  visual?: KmzVisualPayload,
): ClientConvertRequestBody {
  const nextPayload = {
    ...(parsed.map_payload || {}),
    source_format: sourceFormat,
  } as ClientConvertRequestBody["map_payload"];

  if (sourceFormat === "kmz" && visual && hasKmzVisualData(visual)) {
    nextPayload.kmz_visual = visual;
  }

  return {
    ...parsed,
    map_payload: nextPayload,
    source_hash: sourceHash,
  };
}

export async function convertKmlFileInBrowser(file: File): Promise<ClientConvertRequestBody> {
  const sourceFormat = detectSourceFormat(file);

  if (sourceFormat === "kmz") {
    const extracted = await extractKmzForConversion(file);
    const sourceHash = await computeSha256Hex(extracted.kmlText);
    try {
      const parsed = await parseWithWorker(extracted.kmlText, file.name);
      return attachSourceMetadata(parsed, "kmz", sourceHash, extracted.visual);
    } catch {
      const parsed = buildClientConvertRequestFromKmlText(extracted.kmlText, file.name);
      return attachSourceMetadata(parsed, "kmz", sourceHash, extracted.visual);
    }
  }

  if (sourceFormat === "kml") {
    const text = await file.text();
    const sourceHash = await computeSha256Hex(text);
    try {
      const parsed = await parseWithWorker(text, file.name);
      return attachSourceMetadata(parsed, "kml", sourceHash);
    } catch {
      const parsed = buildClientConvertRequestFromKmlText(text, file.name);
      return attachSourceMetadata(parsed, "kml", sourceHash);
    }
  }

  const converted = await convertNonKmlFileInBrowser(file, sourceFormat);
  const sourceHash = await computeSha256Hex(converted.sourceText);
  return attachSourceMetadata(converted.payload, sourceFormat, sourceHash);
}

async function computeSha256Hex(text: string): Promise<string> {
  if (typeof window === "undefined" || !window.crypto || !window.crypto.subtle) {
    return "";
  }
  const encoded = new TextEncoder().encode(text);
  const digest = await window.crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function parseWithWorker(text: string, filename: string): Promise<ClientConvertRequestBody> {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    throw new Error("브라우저 워커를 사용할 수 없습니다.");
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
      reject(new Error("KML 파싱 시간이 초과되었습니다."));
    }, WORKER_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<KmlWorkerResponse>) => {
      const message = event.data;
      cleanup();
      if (!message) {
        reject(new Error("워커 응답이 비어 있습니다."));
        return;
      }
      if (message.type === "success") {
        resolve(message.payload);
        return;
      }
      reject(new Error(toReadableErrorMessage(message.message, "워커에서 KML 변환에 실패했습니다.")));
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(toReadableErrorMessage(event.message, "워커 실행 중 오류가 발생했습니다.")));
    };

    worker.postMessage(payload);

    function cleanup() {
      window.clearTimeout(timer);
      worker.terminate();
    }
  });
}
