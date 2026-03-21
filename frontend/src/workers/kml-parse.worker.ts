/// <reference lib="webworker" />

import type { KmlWorkerRequest, KmlWorkerResponse } from "../lib/kml-client-convert-core";
import { buildClientConvertRequestFromKmlText } from "../lib/kml-client-convert-core";

declare const self: DedicatedWorkerGlobalScope;

function normalizeWorkerError(error: unknown): string {
  if (error instanceof Error) {
    const message = (error.message || "").trim();
    if (message && message !== "[object Object]") {
      return message;
    }
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeMessage = normalizeWorkerError(cause);
    if (causeMessage) {
      return causeMessage;
    }
  }

  if (typeof error === "string") {
    const message = error.trim();
    if (message && message !== "[object Object]") {
      return message;
    }
    return "";
  }

  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const nested = normalizeWorkerError(obj.detail ?? obj.message ?? obj.error ?? obj.cause);
    if (nested) {
      return nested;
    }
    try {
      const serialized = JSON.stringify(obj);
      if (serialized && serialized !== "[object Object]") {
        return serialized;
      }
    } catch {
      return "";
    }
  }

  if (typeof error === "number" || typeof error === "boolean") {
    return String(error);
  }
  return "";
}

self.onmessage = (event: MessageEvent<KmlWorkerRequest>) => {
  const message = event.data;
  if (!message || message.type !== "parse") {
    return;
  }

  try {
    const payload = buildClientConvertRequestFromKmlText(message.text, message.filename);
    const response: KmlWorkerResponse = {
      type: "success",
      payload,
    };
    self.postMessage(response);
  } catch (error) {
    const response: KmlWorkerResponse = {
      type: "error",
      message: normalizeWorkerError(error) || "KML 변환에 실패했습니다.",
    };
    self.postMessage(response);
  }
};

export {};
