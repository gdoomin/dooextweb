import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

import type { ClientConvertRequestBody, PolygonResult } from "@/lib/convert";

export type NonKmlSourceFormat = "gpx" | "geojson" | "csv" | "txt";

export type NonKmlConversionResult = {
  payload: ClientConvertRequestBody;
  sourceText: string;
};

const LAT_HEADERS = new Set(["lat", "latitude", "y", "위도"]);
const LNG_HEADERS = new Set(["lon", "lng", "longitude", "x", "경도"]);
const NAME_HEADERS = ["name", "label", "title", "이름"];

type GeometryCounter = {
  point: number;
  line: number;
  polygon: number;
};

type CsvParseResult = {
  featureCollection: FeatureCollection<Geometry>;
  skippedRows: number;
};

export async function convertNonKmlFileInBrowser(file: File, sourceFormat: NonKmlSourceFormat): Promise<NonKmlConversionResult> {
  const decodedText = await decodeTextFromFile(file);
  const projectName = extractProjectName(file.name);

  let featureCollection: FeatureCollection<Geometry>;
  let skippedRows = 0;
  if (sourceFormat === "gpx") {
    featureCollection = parseGpxAsGeoJson(decodedText);
  } else if (sourceFormat === "geojson") {
    featureCollection = parseGeoJsonText(decodedText);
  } else {
    const parsedCsv = parseCsvOrTxtAsGeoJson(decodedText);
    featureCollection = parsedCsv.featureCollection;
    skippedRows = parsedCsv.skippedRows;
  }

  const normalized = normalizeFeatureCollection(featureCollection);
  if (!normalized.features.length) {
    throw new Error("표시할 데이터가 없습니다.");
  }

  const counters = countGeometryTypes(normalized.features);
  const polygons = collectPolygonResults(normalized.features);
  const payload = buildPayload(projectName, file.name, sourceFormat, normalized, counters, polygons, skippedRows);

  return {
    payload,
    sourceText: decodedText,
  };
}

async function decodeTextFromFile(file: File): Promise<string> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const utf8Text = decodeWithCharset(raw, "utf-8");
  const utf8Score = replacementRatio(utf8Text);

  let eucKrText = "";
  let eucKrScore = Number.POSITIVE_INFINITY;
  try {
    eucKrText = decodeWithCharset(raw, "euc-kr");
    eucKrScore = replacementRatio(eucKrText);
  } catch {
    eucKrText = "";
  }

  if (eucKrText && eucKrScore + 0.003 < utf8Score) {
    return eucKrText;
  }
  return utf8Text;
}

function decodeWithCharset(bytes: Uint8Array, label: string): string {
  return new TextDecoder(label, { fatal: false }).decode(bytes);
}

function replacementRatio(text: string): number {
  if (!text) {
    return 0;
  }
  let replacementCount = 0;
  for (const char of text) {
    if (char === "\uFFFD") {
      replacementCount += 1;
    }
  }
  return replacementCount / Math.max(1, text.length);
}

function extractProjectName(fileName: string): string {
  const cleaned = String(fileName || "upload").trim();
  if (!cleaned) {
    return "DOO_EXTRACTOR";
  }
  const stem = cleaned.replace(/\.[^/.]+$/, "").trim();
  return stem || "DOO_EXTRACTOR";
}

function parseGpxAsGeoJson(text: string): FeatureCollection<Geometry> {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, "application/xml");
  if (xmlDoc.querySelector("parsererror")) {
    throw new Error("GPX 파일 파싱에 실패했습니다.");
  }

  const features: Feature<Geometry>[] = [];
  const trackElements = collectElementsByLocalName(xmlDoc, "trk");
  trackElements.forEach((trackElement, trackIndex) => {
    const trackName = firstDescendantText(trackElement, "name") || `Track ${trackIndex + 1}`;
    const segments = collectElementsByLocalName(trackElement, "trkseg");
    segments.forEach((segmentElement, segmentIndex) => {
      const points = collectElementsByLocalName(segmentElement, "trkpt")
        .map((node) => parseLatLngFromAttributes(node))
        .filter((item): item is [number, number] => Array.isArray(item));
      if (points.length < 2) {
        return;
      }
      features.push({
        type: "Feature",
        properties: {
          name: segments.length > 1 ? `${trackName} #${segmentIndex + 1}` : trackName,
          source_type: "gpx_track",
          style: { color: "#2563eb", weight: 2 },
        },
        geometry: {
          type: "LineString",
          coordinates: points,
        },
      });
    });
  });

  const routeElements = collectElementsByLocalName(xmlDoc, "rte");
  routeElements.forEach((routeElement, routeIndex) => {
    const routeName = firstDescendantText(routeElement, "name") || `Route ${routeIndex + 1}`;
    const points = collectElementsByLocalName(routeElement, "rtept")
      .map((node) => parseLatLngFromAttributes(node))
      .filter((item): item is [number, number] => Array.isArray(item));
    if (points.length < 2) {
      return;
    }
    features.push({
      type: "Feature",
      properties: {
        name: routeName,
        source_type: "gpx_route",
        style: { color: "#2563eb", weight: 2 },
      },
      geometry: {
        type: "LineString",
        coordinates: points,
      },
    });
  });

  const waypointElements = collectElementsByLocalName(xmlDoc, "wpt");
  waypointElements.forEach((waypointElement, waypointIndex) => {
    const coordinate = parseLatLngFromAttributes(waypointElement);
    if (!coordinate) {
      return;
    }
    const name = firstDescendantText(waypointElement, "name") || `Waypoint ${waypointIndex + 1}`;
    const description = firstDescendantText(waypointElement, "desc") || firstDescendantText(waypointElement, "cmt");
    features.push({
      type: "Feature",
      properties: {
        name,
        description,
        source_type: "gpx_waypoint",
      },
      geometry: {
        type: "Point",
        coordinates: coordinate,
      },
    });
  });

  if (!features.length) {
    throw new Error("표시할 데이터가 없습니다.");
  }

  return {
    type: "FeatureCollection",
    features,
  };
}

function parseGeoJsonText(text: string): FeatureCollection<Geometry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("GeoJSON 파일을 파싱하지 못했습니다.");
  }

  const asRecord = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  if (!asRecord || typeof asRecord.type !== "string") {
    throw new Error("GeoJSON 형식이 올바르지 않습니다.");
  }

  if (asRecord.type === "FeatureCollection") {
    const features = Array.isArray(asRecord.features) ? asRecord.features : [];
    return {
      type: "FeatureCollection",
      features: features as Feature<Geometry>[],
    };
  }

  if (asRecord.type === "Feature" && asRecord.geometry && typeof asRecord.geometry === "object") {
    return {
      type: "FeatureCollection",
      features: [asRecord as unknown as Feature<Geometry>],
    };
  }

  if (typeof asRecord.type === "string" && asRecord.coordinates) {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: asRecord as unknown as Geometry,
        },
      ],
    };
  }

  throw new Error("GeoJSON 형식이 올바르지 않습니다.");
}

function parseCsvOrTxtAsGeoJson(text: string): CsvParseResult {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  if (!lines.length) {
    throw new Error("표시할 데이터가 없습니다.");
  }

  const delimiter = detectDelimiter(lines);
  const headers = parseDelimitedLine(lines[0], delimiter).map((item) => item.trim());
  const normalizedHeaders = headers.map((item) => item.toLowerCase());

  const latIndex = findHeaderIndex(normalizedHeaders, LAT_HEADERS);
  const lngIndex = findHeaderIndex(normalizedHeaders, LNG_HEADERS);
  if (latIndex < 0 || lngIndex < 0) {
    throw new Error("위도/경도 컬럼을 찾을 수 없습니다. 컬럼명을 확인해주세요.");
  }

  const nameIndex = findNameHeaderIndex(normalizedHeaders);
  const rows = lines.slice(1).map((line) => parseDelimitedLine(line, delimiter));

  let skippedRows = 0;
  const points: [number, number][] = [];
  const features: Feature<Geometry>[] = [];
  rows.forEach((row, rowIndex) => {
    const latRaw = row[latIndex];
    const lngRaw = row[lngIndex];
    const lat = Number(latRaw);
    const lng = Number(lngRaw);

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      skippedRows += 1;
      return;
    }

    const coordinate: [number, number] = [lng, lat];
    points.push(coordinate);

    if (nameIndex >= 0) {
      const name = String(row[nameIndex] || "").trim() || `Point ${rowIndex + 1}`;
      features.push({
        type: "Feature",
        properties: {
          name,
          source_type: "csv_point",
        },
        geometry: {
          type: "Point",
          coordinates: coordinate,
        },
      });
    }
  });

  if (nameIndex < 0 && points.length >= 2) {
    features.push({
      type: "Feature",
      properties: {
        name: "CSV 경로",
        source_type: "csv_line",
        style: { color: "#2563eb", weight: 2 },
      },
      geometry: {
        type: "LineString",
        coordinates: points,
      },
    });
  }

  if (!features.length) {
    throw new Error("표시할 데이터가 없습니다.");
  }

  return {
    featureCollection: {
      type: "FeatureCollection",
      features,
    },
    skippedRows,
  };
}

function detectDelimiter(lines: string[]): string {
  const candidates = [",", "\t", ";"];
  const sampleLines = lines.slice(0, Math.min(6, lines.length));
  let bestDelimiter = ",";
  let bestScore = -1;

  candidates.forEach((delimiter) => {
    let score = 0;
    sampleLines.forEach((line) => {
      const parsed = parseDelimitedLine(line, delimiter);
      if (parsed.length > 1) {
        score += parsed.length;
      }
    });
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delimiter;
    }
  });

  return bestDelimiter;
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      const next = line[index + 1];
      if (inQuotes && next === "\"") {
        current += "\"";
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && char === delimiter) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current.trim());
  return values;
}

function findHeaderIndex(headers: string[], candidates: Set<string>): number {
  return headers.findIndex((header) => candidates.has(header));
}

function findNameHeaderIndex(headers: string[]): number {
  return headers.findIndex((header) => NAME_HEADERS.includes(header));
}

function collectElementsByLocalName(root: ParentNode, localName: string): Element[] {
  const needle = localName.toLowerCase();
  return Array.from(root.querySelectorAll("*")).filter((element) => nodeLocalName(element) === needle);
}

function nodeLocalName(node: Element): string {
  const raw = node.localName || node.tagName || "";
  return raw.split(":").pop()?.toLowerCase() || "";
}

function firstDescendantText(root: Element, localName: string): string {
  const match = collectElementsByLocalName(root, localName)[0];
  return String(match?.textContent || "").trim();
}

function parseLatLngFromAttributes(node: Element): [number, number] | null {
  const lat = Number(node.getAttribute("lat"));
  const lng = Number(node.getAttribute("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  return [lng, lat];
}

function normalizeFeatureCollection(collection: FeatureCollection<Geometry>): FeatureCollection<Geometry> {
  const features: Feature<Geometry>[] = [];
  collection.features.forEach((feature) => {
    const geometry = feature && feature.geometry ? sanitizeGeometry(feature.geometry) : null;
    if (!geometry) {
      return;
    }

    const properties = feature.properties && typeof feature.properties === "object"
      ? { ...feature.properties }
      : {};
    if (!properties.style || typeof properties.style !== "object") {
      properties.style = defaultStyleForGeometry(geometry.type);
    }

    features.push({
      type: "Feature",
      properties,
      geometry,
    });
  });

  return {
    type: "FeatureCollection",
    features,
  };
}

function defaultStyleForGeometry(geometryType: Geometry["type"]) {
  if (geometryType === "LineString" || geometryType === "MultiLineString") {
    return { color: "#2563eb", weight: 2 };
  }
  if (geometryType === "Polygon" || geometryType === "MultiPolygon") {
    return { color: "#f97316", weight: 2, fillColor: "#f97316", fillOpacity: 0.3 };
  }
  return { color: "#dc2626", radius: 6 };
}

function sanitizeGeometry(geometry: Geometry): Geometry | null {
  switch (geometry.type) {
    case "Point": {
      const coordinate = normalizePosition(geometry.coordinates);
      if (!coordinate) {
        return null;
      }
      return { ...geometry, coordinates: coordinate };
    }
    case "MultiPoint": {
      const coordinates = geometry.coordinates.map(normalizePosition).filter((item): item is Position => Array.isArray(item));
      if (!coordinates.length) {
        return null;
      }
      return { ...geometry, coordinates };
    }
    case "LineString": {
      const coordinates = geometry.coordinates.map(normalizePosition).filter((item): item is Position => Array.isArray(item));
      if (coordinates.length < 2) {
        return null;
      }
      return { ...geometry, coordinates };
    }
    case "MultiLineString": {
      const lines = geometry.coordinates
        .map((line) => line.map(normalizePosition).filter((item): item is Position => Array.isArray(item)))
        .filter((line) => line.length >= 2);
      if (!lines.length) {
        return null;
      }
      return { ...geometry, coordinates: lines };
    }
    case "Polygon": {
      const rings = geometry.coordinates
        .map((ring) => closeRing(ring.map(normalizePosition).filter((item): item is Position => Array.isArray(item))))
        .filter((ring) => ring.length >= 4);
      if (!rings.length) {
        return null;
      }
      return { ...geometry, coordinates: rings };
    }
    case "MultiPolygon": {
      const polygons = geometry.coordinates
        .map((polygon) =>
          polygon
            .map((ring) => closeRing(ring.map(normalizePosition).filter((item): item is Position => Array.isArray(item))))
            .filter((ring) => ring.length >= 4),
        )
        .filter((polygon) => polygon.length > 0);
      if (!polygons.length) {
        return null;
      }
      return { ...geometry, coordinates: polygons };
    }
    case "GeometryCollection": {
      const geometries = geometry.geometries.map((item) => sanitizeGeometry(item)).filter((item): item is Geometry => Boolean(item));
      if (!geometries.length) {
        return null;
      }
      return { ...geometry, geometries };
    }
    default:
      return null;
  }
}

function normalizePosition(position: Position): Position | null {
  if (!Array.isArray(position) || position.length < 2) {
    return null;
  }
  const lng = Number(position[0]);
  const lat = Number(position[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  if (position.length > 2 && Number.isFinite(Number(position[2]))) {
    return [lng, lat, Number(position[2])];
  }
  return [lng, lat];
}

function closeRing(ring: Position[]): Position[] {
  if (ring.length < 3) {
    return ring;
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) {
    return ring;
  }
  return [...ring, first];
}

function countGeometryTypes(features: Feature<Geometry>[]): GeometryCounter {
  const counters: GeometryCounter = { point: 0, line: 0, polygon: 0 };
  features.forEach((feature) => {
    const geometry = feature.geometry;
    if (!geometry) {
      return;
    }
    if (geometry.type === "Point" || geometry.type === "MultiPoint") {
      counters.point += 1;
    } else if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
      counters.line += 1;
    } else if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
      counters.polygon += 1;
    } else if (geometry.type === "GeometryCollection") {
      geometry.geometries.forEach((item) => {
        if (item.type === "Point" || item.type === "MultiPoint") {
          counters.point += 1;
        } else if (item.type === "LineString" || item.type === "MultiLineString") {
          counters.line += 1;
        } else if (item.type === "Polygon" || item.type === "MultiPolygon") {
          counters.polygon += 1;
        }
      });
    }
  });
  return counters;
}

function collectPolygonResults(features: Feature<Geometry>[]): PolygonResult[] {
  const polygons: PolygonResult[] = [];
  features.forEach((feature, index) => {
    if (!feature.geometry) {
      return;
    }
    const label = resolveFeatureLabel(feature, index);
    if (feature.geometry.type === "Polygon") {
      const ring = feature.geometry.coordinates[0] || [];
      const points = ring
        .map((position) => [Number(position[1]), Number(position[0])] as [number, number])
        .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
      if (points.length >= 3) {
        polygons.push({ num: label, label, points });
      }
      return;
    }
    if (feature.geometry.type === "MultiPolygon") {
      feature.geometry.coordinates.forEach((polygon, polygonIndex) => {
        const ring = polygon[0] || [];
        const points = ring
          .map((position) => [Number(position[1]), Number(position[0])] as [number, number])
          .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
        if (points.length >= 3) {
          polygons.push({ num: label, label: `${label} #${polygonIndex + 1}`, points });
        }
      });
    }
  });
  return polygons;
}

function resolveFeatureLabel(feature: Feature<Geometry>, index: number): string {
  const props = feature.properties && typeof feature.properties === "object"
    ? feature.properties
    : {};
  const name = props.name || props.label || props.title || props.description;
  if (typeof name === "string" && name.trim()) {
    return name.trim();
  }
  return `Feature ${index + 1}`;
}

function buildPayload(
  projectName: string,
  fileName: string,
  sourceFormat: NonKmlSourceFormat,
  featureCollection: FeatureCollection<Geometry>,
  counters: GeometryCounter,
  polygons: PolygonResult[],
  skippedRows: number,
): ClientConvertRequestBody {
  const parts = [
    `포인트 ${counters.point}개`,
    `라인 ${counters.line}개`,
    `폴리곤 ${counters.polygon}개`,
  ];
  if (sourceFormat === "csv" || sourceFormat === "txt") {
    parts.push(`스킵 ${skippedRows}행`);
  }
  const summaryText = parts.join(" · ");
  const textOutput = [
    `프로젝트: ${projectName}`,
    "======================================================================",
    `소스 형식: ${sourceFormat.toUpperCase()}`,
    `총 객체: ${featureCollection.features.length}개`,
    summaryText,
  ].join("\n");

  return {
    filename: fileName,
    project_name: projectName,
    mode: "polygon",
    result_count: featureCollection.features.length,
    text_output: textOutput,
    map_payload: {
      project_name: projectName,
      mode: "polygon",
      results: [],
      polygons,
      has_kml_num: false,
      default_force_num: false,
      default_show_num: false,
      has_layers: false,
      layer_catalog: [],
      default_gray_map: false,
      meta_text: summaryText,
      geojson: featureCollection as FeatureCollection<Geometry | null>,
      source_format: sourceFormat,
      coordinate_count: countCoordinates(featureCollection),
    },
    results: [],
  };
}

function countCoordinates(collection: FeatureCollection<Geometry>): number {
  return collection.features.reduce((sum, feature) => sum + countGeometryCoordinates(feature.geometry), 0);
}

function countGeometryCoordinates(geometry: Geometry): number {
  switch (geometry.type) {
    case "Point":
      return 1;
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates.length;
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates.reduce((sum, row) => sum + row.length, 0);
    case "MultiPolygon":
      return geometry.coordinates.reduce(
        (sum, polygon) => sum + polygon.reduce((ringSum, ring) => ringSum + ring.length, 0),
        0,
      );
    case "GeometryCollection":
      return geometry.geometries.reduce((sum, item) => sum + countGeometryCoordinates(item), 0);
    default:
      return 0;
  }
}
