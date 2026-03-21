import JSZip from "jszip";

import type { KmzGroundOverlay, KmzPointMarker, KmzVisualPayload } from "@/lib/convert";

type ParsedIconStyle = {
  href?: string;
  scale?: number;
};

export type KmzExtractionResult = {
  kmlText: string;
  visual: KmzVisualPayload;
};

type AssetResolver = (href: string) => Promise<string>;

export async function extractKmzForConversion(file: File): Promise<KmzExtractionResult> {
  const archiveBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(archiveBuffer);
  const kmlEntry = pickPrimaryKmlEntry(zip);
  if (!kmlEntry) {
    throw new Error("KMZ 파일 내부에서 KML을 찾지 못했습니다.");
  }

  const kmlText = await kmlEntry.async("text");
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(kmlText, "application/xml");
  if (xmlDoc.querySelector("parsererror")) {
    throw new Error("KMZ 내부 KML 파싱에 실패했습니다.");
  }

  const kmlDir = resolveDirectory(kmlEntry.name);
  const assetIndex = buildAssetIndex(zip);
  const assetCache = new Map<string, string>();
  const resolveAssetHref = createAssetResolver(assetIndex, assetCache, kmlDir);

  const styleIcons = collectStyleIcons(xmlDoc);
  const styleMap = collectStyleMap(xmlDoc);
  const pointMarkers = await collectPointMarkers(xmlDoc, styleIcons, styleMap, resolveAssetHref);
  const groundOverlays = await collectGroundOverlays(xmlDoc, resolveAssetHref);

  return {
    kmlText,
    visual: {
      ground_overlays: groundOverlays,
      point_markers: pointMarkers,
    },
  };
}

function pickPrimaryKmlEntry(zip: JSZip): JSZip.JSZipObject | null {
  const candidates = Object.values(zip.files)
    .filter((entry) => !entry.dir && /\.kml$/i.test(entry.name))
    .sort((left, right) => left.name.length - right.name.length);
  if (!candidates.length) {
    return null;
  }

  const docKml = candidates.find((entry) => entry.name.toLowerCase().endsWith("doc.kml"));
  return docKml || candidates[0];
}

function resolveDirectory(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  if (index < 0) {
    return "";
  }
  return normalized.slice(0, index);
}

function normalizePath(path: string): string {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .trim();
}

function canonicalizePath(path: string): string {
  const parts: string[] = [];
  normalizePath(path)
    .split("/")
    .forEach((segment) => {
      if (!segment || segment === ".") {
        return;
      }
      if (segment === "..") {
        parts.pop();
        return;
      }
      parts.push(segment);
    });
  return parts.join("/").toLowerCase();
}

function stripQueryAndHash(path: string): string {
  return path.replace(/[?#].*$/, "");
}

function buildAssetIndex(zip: JSZip): Map<string, JSZip.JSZipObject> {
  const index = new Map<string, JSZip.JSZipObject>();
  Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .forEach((entry) => {
      index.set(canonicalizePath(entry.name), entry);
    });
  return index;
}

function createAssetResolver(
  index: Map<string, JSZip.JSZipObject>,
  cache: Map<string, string>,
  kmlDir: string,
): AssetResolver {
  return async (rawHref: string) => {
    const href = String(rawHref || "").trim();
    if (!href) {
      return "";
    }
    if (/^(https?:|data:|blob:)/i.test(href)) {
      return href;
    }

    const decoded = decodeSafe(stripQueryAndHash(href));
    const candidates = [
      canonicalizePath(decoded),
      canonicalizePath(`${kmlDir}/${decoded}`),
    ].filter(Boolean);

    for (const key of candidates) {
      if (cache.has(key)) {
        return cache.get(key) || "";
      }
      const entry = index.get(key);
      if (!entry) {
        continue;
      }
      const dataUrl = await zipEntryToDataUrl(entry);
      cache.set(key, dataUrl);
      return dataUrl;
    }

    return href;
  };
}

async function zipEntryToDataUrl(entry: JSZip.JSZipObject): Promise<string> {
  const mime = guessMimeType(entry.name);
  const base64 = await entry.async("base64");
  return `data:${mime};base64,${base64}`;
}

function guessMimeType(path: string): string {
  const lower = normalizePath(path).toLowerCase();
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (lower.endsWith(".bmp")) {
    return "image/bmp";
  }
  return "application/octet-stream";
}

function collectElementsByLocalName(root: ParentNode, localName: string): Element[] {
  const needle = localName.toLowerCase();
  return Array.from(root.querySelectorAll("*")).filter((node) => nodeLocalName(node) === needle);
}

function nodeLocalName(node: Element): string {
  const raw = node.localName || node.tagName || "";
  return raw.split(":").pop()?.toLowerCase() || "";
}

function firstDirectChildText(parent: Element, localName: string): string {
  const needle = localName.toLowerCase();
  for (const child of Array.from(parent.children)) {
    if (nodeLocalName(child) === needle) {
      return String(child.textContent || "").trim();
    }
  }
  return "";
}

function firstDescendantText(parent: Element, localName: string): string {
  const needle = localName.toLowerCase();
  const match = collectElementsByLocalName(parent, needle)[0];
  return match ? String(match.textContent || "").trim() : "";
}

function collectStyleIcons(xmlDoc: XMLDocument): Map<string, ParsedIconStyle> {
  const styles = new Map<string, ParsedIconStyle>();
  const styleElements = collectElementsByLocalName(xmlDoc, "Style");
  styleElements.forEach((styleElement) => {
    const styleId = String(styleElement.getAttribute("id") || "").trim();
    if (!styleId) {
      return;
    }

    const iconStyle = collectElementsByLocalName(styleElement, "IconStyle")[0];
    if (!iconStyle) {
      return;
    }

    const iconHref = firstDescendantText(iconStyle, "href");
    const scaleRaw = firstDescendantText(iconStyle, "scale");
    const scale = Number(scaleRaw);
    const style: ParsedIconStyle = {};
    if (iconHref) {
      style.href = iconHref;
    }
    if (Number.isFinite(scale) && scale > 0) {
      style.scale = scale;
    }
    if (style.href || style.scale) {
      styles.set(styleId, style);
    }
  });

  return styles;
}

function collectStyleMap(xmlDoc: XMLDocument): Map<string, string> {
  const styleMap = new Map<string, string>();
  const styleMapElements = collectElementsByLocalName(xmlDoc, "StyleMap");
  styleMapElements.forEach((styleMapElement) => {
    const styleMapId = String(styleMapElement.getAttribute("id") || "").trim();
    if (!styleMapId) {
      return;
    }

    const pairElements = collectElementsByLocalName(styleMapElement, "Pair");
    let target = "";
    pairElements.forEach((pairElement) => {
      const key = firstDescendantText(pairElement, "key").toLowerCase();
      const styleUrl = normalizeStyleUrl(firstDescendantText(pairElement, "styleUrl"));
      if (!styleUrl) {
        return;
      }
      if (!target || key === "normal") {
        target = styleUrl;
      }
    });

    if (target) {
      styleMap.set(styleMapId, target);
    }
  });
  return styleMap;
}

function normalizeStyleUrl(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("#")) {
    return trimmed.slice(1).trim();
  }
  return trimmed;
}

async function collectPointMarkers(
  xmlDoc: XMLDocument,
  styleIcons: Map<string, ParsedIconStyle>,
  styleMap: Map<string, string>,
  resolveAssetHref: AssetResolver,
): Promise<KmzPointMarker[]> {
  const markers: KmzPointMarker[] = [];
  const placemarks = collectElementsByLocalName(xmlDoc, "Placemark");
  for (let index = 0; index < placemarks.length; index += 1) {
    const placemark = placemarks[index];
    const pointElement = collectElementsByLocalName(placemark, "Point")[0];
    if (!pointElement) {
      continue;
    }

    const coordinateText = firstDescendantText(pointElement, "coordinates");
    const coordinate = parseCoordinate(coordinateText);
    if (!coordinate) {
      continue;
    }

    const inlineIconStyle = collectElementsByLocalName(placemark, "IconStyle")[0];
    const inlineHref = inlineIconStyle ? firstDescendantText(inlineIconStyle, "href") : "";
    const inlineScaleRaw = inlineIconStyle ? firstDescendantText(inlineIconStyle, "scale") : "";
    const inlineScale = Number(inlineScaleRaw);

    const styleUrl = normalizeStyleUrl(firstDescendantText(placemark, "styleUrl"));
    const resolvedStyleId = styleMap.get(styleUrl) || styleUrl;
    const style = styleIcons.get(resolvedStyleId || "");

    const iconHrefRaw = inlineHref || style?.href || "";
    const iconHref = iconHrefRaw ? await resolveAssetHref(iconHrefRaw) : "";
    const iconScale = Number.isFinite(inlineScale) && inlineScale > 0
      ? inlineScale
      : Number.isFinite(style?.scale) && Number(style?.scale) > 0
        ? Number(style?.scale)
        : undefined;

    const marker: KmzPointMarker = {
      id: `kmz-point-${index + 1}`,
      name: firstDirectChildText(placemark, "name"),
      description: firstDirectChildText(placemark, "description"),
      lat: coordinate.lat,
      lng: coordinate.lng,
    };
    if (iconHref) {
      marker.icon_href = iconHref;
    }
    if (iconScale) {
      marker.icon_scale = iconScale;
    }
    markers.push(marker);
  }
  return markers;
}

async function collectGroundOverlays(xmlDoc: XMLDocument, resolveAssetHref: AssetResolver): Promise<KmzGroundOverlay[]> {
  const overlays: KmzGroundOverlay[] = [];
  const groundElements = collectElementsByLocalName(xmlDoc, "GroundOverlay");
  for (let index = 0; index < groundElements.length; index += 1) {
    const item = groundElements[index];
    const hrefRaw = firstDescendantText(item, "href");
    if (!hrefRaw) {
      continue;
    }
    const north = Number(firstDescendantText(item, "north"));
    const south = Number(firstDescendantText(item, "south"));
    const east = Number(firstDescendantText(item, "east"));
    const west = Number(firstDescendantText(item, "west"));
    if (![north, south, east, west].every((value) => Number.isFinite(value))) {
      continue;
    }

    const imageHref = await resolveAssetHref(hrefRaw);
    if (!imageHref) {
      continue;
    }

    const drawOrder = Number(firstDescendantText(item, "drawOrder"));
    const rotation = Number(firstDescendantText(item, "rotation"));
    const colorRaw = firstDescendantText(item, "color");
    const opacity = kmlColorToOpacity(colorRaw);

    const overlay: KmzGroundOverlay = {
      id: `kmz-overlay-${index + 1}`,
      name: firstDirectChildText(item, "name"),
      image_href: imageHref,
      bounds: [
        [south, west],
        [north, east],
      ],
    };
    if (Number.isFinite(drawOrder)) {
      overlay.draw_order = drawOrder;
    }
    if (Number.isFinite(rotation)) {
      overlay.rotation = rotation;
    }
    if (Number.isFinite(opacity)) {
      overlay.opacity = opacity;
    }
    overlays.push(overlay);
  }
  return overlays;
}

function parseCoordinate(raw: string): { lat: number; lng: number } | null {
  const token = String(raw || "").trim().split(/\s+/)[0] || "";
  if (!token) {
    return null;
  }
  const parts = token.split(",");
  if (parts.length < 2) {
    return null;
  }
  const lng = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  return { lat, lng };
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function kmlColorToOpacity(rawColor: string): number | undefined {
  const color = String(rawColor || "").trim();
  if (!/^[0-9a-fA-F]{8}$/.test(color)) {
    return undefined;
  }
  const alphaHex = color.slice(0, 2);
  const alpha = Number.parseInt(alphaHex, 16);
  if (!Number.isFinite(alpha)) {
    return undefined;
  }
  return Math.max(0, Math.min(1, alpha / 255));
}
