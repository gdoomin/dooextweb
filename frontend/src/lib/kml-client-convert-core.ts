import { kml as toGeoJsonKml } from "@tmcw/togeojson";
import simplify from "@turf/simplify";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  GeometryCollection,
  LineString,
  MultiLineString,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";

import type { ClientConvertRequestBody, LineResult, MapPayload, PolygonResult } from "@/lib/convert";

const POLYGON_ONLY_MESSAGE = "시작점과 끝점이 없는 폴리곤 파일입니다.";
const EARTH_RADIUS_KM = 6371.0088;
const AIRCRAFT_SPEED_KNOTS = 130;
const KNOT_TO_KMH = 1.852;
const TURN_MINUTES_PER_LINE = 3;
const GENERIC_LINE_NAMES = new Set(["line", "linestring", "flight line"]);

export type KmlWorkerRequest = {
  type: "parse";
  filename: string;
  text: string;
};

export type KmlWorkerSuccess = {
  type: "success";
  payload: ClientConvertRequestBody;
};

export type KmlWorkerError = {
  type: "error";
  message: string;
};

export type KmlWorkerResponse = KmlWorkerSuccess | KmlWorkerError;

type LineStorageRow = {
  num: string;
  s_lat: number;
  s_lon: number;
  e_lat: number;
  e_lon: number;
};

type PolygonStorageRow = {
  num: string;
  points: [number, number][];
};

type ParsedPolygon = {
  baseName: string;
  pointsLonLat: [number, number][];
};

type GeometryFeature = Feature<Geometry>;

export function buildClientConvertRequestFromKmlText(kmlText: string, fileName: string): ClientConvertRequestBody {
  const projectName = extractProjectName(fileName);
  const xmlDoc = parseKmlXml(kmlText);
  const sourceCollection = toGeoJsonKml(xmlDoc, { skipNullGeometry: true });
  const features = sourceCollection.features
    .map((feature) => normalizeFeature(feature))
    .filter((feature): feature is GeometryFeature => feature !== null);

  if (!features.length) {
    throw new Error("KML에서 LineString 또는 Polygon 데이터를 찾지 못했습니다.");
  }

  const lineRows = extractLineRowsWithFolderContext(features, xmlDoc);
  if (lineRows.length > 0) {
    return buildLineModePayload(projectName, fileName, features, lineRows);
  }

  const polygons = extractPolygons(features);
  if (!polygons.length) {
    throw new Error("KML에서 LineString 또는 Polygon 데이터를 찾지 못했습니다.");
  }
  return buildPolygonModePayload(projectName, fileName, polygons, features);
}

function buildLineModePayload(
  projectName: string,
  fileName: string,
  features: GeometryFeature[],
  lineRows: LineStorageRow[],
): ClientConvertRequestBody {
  const lineFeatures = features.filter((feature) => isLineGeometry(feature.geometry));
  const rawGeojson: FeatureCollection<Geometry> = {
    type: "FeatureCollection",
    features: lineFeatures,
  };
  const coordinateCount = countFeatureCollectionCoordinates(rawGeojson);
  const tolerance = chooseSimplifyTolerance(coordinateCount);
  const simplifiedGeojson = simplifyFeatureCollection(rawGeojson, tolerance);
  const roundedGeojson = roundFeatureCollection(simplifiedGeojson);
  const forceLabels = buildForceLabels(lineRows);

  const payloadResults: LineResult[] = lineRows.map((row, index) => ({
    num: row.num,
    force_label: forceLabels.get(index) ?? String(index + 1),
    force_order: Number(forceLabels.get(index) ?? String(index + 1)),
    s_lat: roundCoordinate(row.s_lat),
    s_lon: roundCoordinate(row.s_lon),
    e_lat: roundCoordinate(row.e_lat),
    e_lon: roundCoordinate(row.e_lon),
    s_text: `${ddToDms(row.s_lat, true)} ${ddToDms(row.s_lon, false)}`,
    e_text: `${ddToDms(row.e_lat, true)} ${ddToDms(row.e_lon, false)}`,
  }));

  const hasKmlNum = payloadResults.length > 0 && payloadResults.every((row) => Boolean(row.num?.trim()));
  const mapPayload: MapPayload = {
    project_name: projectName,
    mode: "linestring",
    results: payloadResults,
    polygons: [],
    has_kml_num: hasKmlNum,
    default_force_num: !hasKmlNum,
    default_show_num: hasKmlNum,
    has_layers: false,
    layer_catalog: [],
    default_gray_map: false,
    meta_text: buildLineMetaText(lineRows),
    geojson: roundedGeojson as FeatureCollection<Geometry | null>,
    source_format: "kml",
    simplify_tolerance: tolerance,
    coordinate_count: coordinateCount,
  };

  return {
    filename: fileName,
    project_name: projectName,
    mode: "linestring",
    result_count: payloadResults.length,
    text_output: formatLinesAsText(lineRows, projectName),
    map_payload: mapPayload,
    results: lineRows.map((row) => ({ ...row })),
  };
}

function buildPolygonModePayload(
  projectName: string,
  fileName: string,
  polygons: ParsedPolygon[],
  features: GeometryFeature[],
): ClientConvertRequestBody {
  const polygonFeatures = features.filter((feature) => isPolygonGeometry(feature.geometry));
  const rawGeojson: FeatureCollection<Geometry> = {
    type: "FeatureCollection",
    features: polygonFeatures,
  };
  const coordinateCount = countFeatureCollectionCoordinates(rawGeojson);
  const tolerance = chooseSimplifyTolerance(coordinateCount);
  const simplifiedGeojson = simplifyFeatureCollection(rawGeojson, tolerance);
  const roundedGeojson = roundFeatureCollection(simplifiedGeojson);

  const payloadPolygons: PolygonResult[] = polygons.map((polygon, index) => {
    const label = polygon.baseName || `Polygon ${index + 1}`;
    return {
      num: polygon.baseName,
      label,
      points: polygon.pointsLonLat.map(([lon, lat]) => [roundCoordinate(lat), roundCoordinate(lon)]),
    };
  });

  const storageRows: PolygonStorageRow[] = polygons.map((polygon) => ({
    num: polygon.baseName,
    points: polygon.pointsLonLat.map(([lon, lat]) => [roundCoordinate(lon), roundCoordinate(lat)]),
  }));

  const mapPayload: MapPayload = {
    project_name: projectName,
    mode: "polygon",
    results: [],
    polygons: payloadPolygons,
    has_kml_num: false,
    default_force_num: false,
    default_show_num: false,
    has_layers: false,
    layer_catalog: [],
    default_gray_map: false,
    meta_text: `${payloadPolygons.length}개 폴리곤`,
    geojson: roundedGeojson as FeatureCollection<Geometry | null>,
    source_format: "kml",
    simplify_tolerance: tolerance,
    coordinate_count: coordinateCount,
  };

  return {
    filename: fileName,
    project_name: projectName,
    mode: "polygon",
    result_count: payloadPolygons.length,
    text_output: formatPolygonText(projectName),
    map_payload: mapPayload,
    results: storageRows.map((row) => ({ ...row })),
  };
}

function parseKmlXml(kmlText: string): XMLDocument {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(kmlText, "application/xml");
  if (xmlDoc.querySelector("parsererror")) {
    throw new Error("KML XML을 파싱하지 못했습니다.");
  }
  return xmlDoc;
}

function normalizeFeature(feature: Feature<Geometry | null>): GeometryFeature | null {
  if (!feature || !feature.geometry) {
    return null;
  }
  if (!geometryHasUsableCoordinates(feature.geometry)) {
    return null;
  }
  return {
    ...feature,
    geometry: feature.geometry,
    properties: feature.properties ?? {},
  };
}

function geometryHasUsableCoordinates(geometry: Geometry): boolean {
  switch (geometry.type) {
    case "LineString":
      return geometry.coordinates.some((position) => toLonLat(position) !== null);
    case "MultiLineString":
      return geometry.coordinates.some((line) => line.some((position) => toLonLat(position) !== null));
    case "Polygon":
      return geometry.coordinates.some((ring) => ring.some((position) => toLonLat(position) !== null));
    case "MultiPolygon":
      return geometry.coordinates.some((polygon) => polygon.some((ring) => ring.some((position) => toLonLat(position) !== null)));
    case "Point":
      return toLonLat(geometry.coordinates) !== null;
    case "MultiPoint":
      return geometry.coordinates.some((position) => toLonLat(position) !== null);
    case "GeometryCollection":
      return geometry.geometries.some((item) => geometryHasUsableCoordinates(item));
    default:
      return false;
  }
}

function extractLineRows(features: GeometryFeature[]): LineStorageRow[] {
  const rows: LineStorageRow[] = [];
  features.forEach((feature) => {
    const points = extractLineCoordinates(feature.geometry);
    if (points.length < 2) {
      return;
    }

    const start = points[0];
    const end = points[points.length - 1];
    rows.push({
      num: extractFeatureName(feature),
      s_lat: start[1],
      s_lon: start[0],
      e_lat: end[1],
      e_lon: end[0],
    });
  });
  return rows;
}

type PlacemarkContext = {
  placemark: Element;
  folderNames: string[];
};

function extractLineRowsWithFolderContext(features: GeometryFeature[], xmlDoc: XMLDocument): LineStorageRow[] {
  const rowsFromDom = extractLineRowsFromKmlDom(xmlDoc);
  if (rowsFromDom.length > 0) {
    return rowsFromDom;
  }
  return extractLineRows(features);
}

function extractLineRowsFromKmlDom(xmlDoc: XMLDocument): LineStorageRow[] {
  const root = xmlDoc.documentElement;
  if (!root) {
    return [];
  }

  const rows: LineStorageRow[] = [];
  const placemarkContexts = collectPlacemarksWithContext(root);
  placemarkContexts.forEach(({ placemark, folderNames }) => {
    const rawName = findDirectChildText(placemark, "name");
    const resolvedName = resolveLineName(rawName, folderNames);
    const lineStrings = findDescendantsByLocalName(placemark, "LineString");

    lineStrings.forEach((lineString) => {
      const coordinateText = findDescendantText(lineString, "coordinates");
      if (!coordinateText) {
        return;
      }

      const points = parseKmlCoordinateText(coordinateText);
      if (points.length < 2) {
        return;
      }

      const [startLon, startLat] = points[0];
      const [endLon, endLat] = points[points.length - 1];
      rows.push({
        num: resolvedName,
        s_lat: startLat,
        s_lon: startLon,
        e_lat: endLat,
        e_lon: endLon,
      });
    });
  });

  return rows;
}

function collectPlacemarksWithContext(root: Element): PlacemarkContext[] {
  const collected: PlacemarkContext[] = [];

  const visit = (node: Element, folderNames: string[]) => {
    const tagName = localNameOf(node);
    let nextFolderNames = folderNames;

    if (tagName === "Folder") {
      const folderName = findDirectChildText(node, "name");
      if (folderName) {
        nextFolderNames = [...folderNames, folderName];
      }
    }

    if (tagName === "Placemark") {
      collected.push({
        placemark: node,
        folderNames: nextFolderNames,
      });
      return;
    }

    Array.from(node.children).forEach((child) => visit(child, nextFolderNames));
  };

  visit(root, []);
  return collected;
}

function resolveLineName(rawName: string, folderNames: string[]): string {
  const cleaned = rawName.trim();
  const normalized = cleaned.replace(/\s+/g, " ").toLowerCase();
  if (cleaned && !GENERIC_LINE_NAMES.has(normalized)) {
    return cleaned;
  }

  const contextName = extractContextLineName(folderNames);
  return contextName || cleaned;
}

function extractContextLineName(folderNames: string[]): string {
  for (let index = folderNames.length - 1; index >= 0; index -= 1) {
    const candidate = folderNames[index].trim();
    if (!candidate) {
      continue;
    }

    const lineTagged = candidate.match(/(?:flight\s*line|line)\s*\[([^\]]+)\]/i);
    if (lineTagged?.[1]) {
      return lineTagged[1].trim();
    }

    const bracketed = candidate.match(/\[([^\]]+)\]/);
    if (bracketed?.[1]) {
      return bracketed[1].trim();
    }

    if (/^[A-Za-z]?\d+[A-Za-z]?$/.test(candidate)) {
      return candidate;
    }
  }
  return "";
}

function parseKmlCoordinateText(raw: string): [number, number][] {
  const points: [number, number][] = [];
  raw
    .trim()
    .split(/\s+/)
    .forEach((token) => {
      const parts = token.split(",");
      if (parts.length < 2) {
        return;
      }

      const lon = Number(parts[0]);
      const lat = Number(parts[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        return;
      }

      points.push([lon, lat]);
    });
  return points;
}

function findDescendantsByLocalName(root: Element, target: string): Element[] {
  const wanted = target.toLowerCase();
  const found: Element[] = [];

  const walk = (node: Element) => {
    if (localNameOf(node).toLowerCase() === wanted) {
      found.push(node);
    }
    Array.from(node.children).forEach((child) => walk(child));
  };

  walk(root);
  return found;
}

function findDescendantText(root: Element, target: string): string {
  const wanted = target.toLowerCase();
  const queue = [...Array.from(root.children)];

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) {
      continue;
    }

    if (localNameOf(node).toLowerCase() === wanted) {
      return (node.textContent || "").trim();
    }

    queue.push(...Array.from(node.children));
  }

  return "";
}

function findDirectChildText(parent: Element, target: string): string {
  const wanted = target.toLowerCase();
  for (const child of Array.from(parent.children)) {
    if (localNameOf(child).toLowerCase() === wanted) {
      return (child.textContent || "").trim();
    }
  }
  return "";
}

function localNameOf(element: Element): string {
  const raw = element.localName || element.tagName || "";
  const parts = raw.split(":");
  return parts[parts.length - 1];
}

function extractPolygons(features: GeometryFeature[]): ParsedPolygon[] {
  const polygons: ParsedPolygon[] = [];
  features.forEach((feature) => {
    const baseName = extractFeatureName(feature);
    const rings = extractPolygonOuterRings(feature.geometry);
    if (!rings.length) {
      return;
    }
    rings.forEach((ring, index) => {
      const normalizedRing = stripClosingPoint(ring);
      if (normalizedRing.length < 3) {
        return;
      }
      const resolvedName = baseName && rings.length > 1 ? `${baseName} #${index + 1}` : baseName;
      polygons.push({ baseName: resolvedName, pointsLonLat: normalizedRing });
    });
  });
  return polygons;
}

function extractLineCoordinates(geometry: Geometry): [number, number][] {
  if (geometry.type === "LineString") {
    return geometry.coordinates.map(toLonLat).filter((point): point is [number, number] => point !== null);
  }
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates
      .flatMap((line) => line)
      .map(toLonLat)
      .filter((point): point is [number, number] => point !== null);
  }
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.flatMap((item) => extractLineCoordinates(item));
  }
  return [];
}

function extractPolygonOuterRings(geometry: Geometry): [number, number][][] {
  if (geometry.type === "Polygon") {
    const ring = geometry.coordinates[0] ?? [];
    return [ring.map(toLonLat).filter((point): point is [number, number] => point !== null)];
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.map((polygon) => {
      const ring = polygon[0] ?? [];
      return ring.map(toLonLat).filter((point): point is [number, number] => point !== null);
    });
  }
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.flatMap((item) => extractPolygonOuterRings(item));
  }
  return [];
}

function stripClosingPoint(points: [number, number][]): [number, number][] {
  if (points.length < 2) {
    return points;
  }
  const [firstLon, firstLat] = points[0];
  const [lastLon, lastLat] = points[points.length - 1];
  if (firstLon === lastLon && firstLat === lastLat) {
    return points.slice(0, -1);
  }
  return points;
}

function simplifyFeatureCollection(collection: FeatureCollection<Geometry>, tolerance: number): FeatureCollection<Geometry> {
  if (tolerance <= 0) {
    return collection;
  }
  try {
    return simplify(collection, {
      tolerance,
      highQuality: false,
      mutate: false,
    });
  } catch {
    return collection;
  }
}

function chooseSimplifyTolerance(totalCoordinates: number): number {
  if (totalCoordinates >= 160000) {
    return 0.0002;
  }
  if (totalCoordinates >= 80000) {
    return 0.00012;
  }
  if (totalCoordinates >= 24000) {
    return 0.00008;
  }
  if (totalCoordinates >= 6000) {
    return 0.00004;
  }
  return 0;
}

function countFeatureCollectionCoordinates(collection: FeatureCollection<Geometry>): number {
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
      return geometry.coordinates.reduce((sum, ring) => sum + ring.length, 0);
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

function roundFeatureCollection(collection: FeatureCollection<Geometry>): FeatureCollection<Geometry> {
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => ({
      ...feature,
      geometry: roundGeometry(feature.geometry),
    })),
  };
}

function roundGeometry(geometry: Geometry): Geometry {
  switch (geometry.type) {
    case "Point":
      return { ...geometry, coordinates: roundPosition(geometry.coordinates) };
    case "MultiPoint":
      return { ...geometry, coordinates: geometry.coordinates.map((point) => roundPosition(point)) };
    case "LineString":
      return { ...geometry, coordinates: geometry.coordinates.map((point) => roundPosition(point)) };
    case "MultiLineString":
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((line) => line.map((point) => roundPosition(point))),
      };
    case "Polygon":
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((ring) => ring.map((point) => roundPosition(point))),
      };
    case "MultiPolygon":
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map((point) => roundPosition(point)))),
      };
    case "GeometryCollection":
      return {
        ...geometry,
        geometries: geometry.geometries.map((child) => roundGeometry(child)),
      } as GeometryCollection;
    default:
      return geometry;
  }
}

function roundPosition(position: Position): Position {
  const [lon, lat, ...rest] = position;
  const rounded: Position = [roundCoordinate(Number(lon)), roundCoordinate(Number(lat))];
  if (rest.length > 0 && Number.isFinite(rest[0])) {
    rounded.push(roundCoordinate(Number(rest[0])));
  }
  return rounded;
}

function buildForceLabels(rows: LineStorageRow[]): Map<number, string> {
  const ranked = rows
    .map((row, index) => ({
      index,
      lat: (row.s_lat + row.e_lat) / 2,
      lon: (row.s_lon + row.e_lon) / 2,
    }))
    .sort((left, right) => {
      if (right.lat !== left.lat) {
        return right.lat - left.lat;
      }
      return left.lon - right.lon;
    });

  const labels = new Map<number, string>();
  ranked.forEach((row, rank) => {
    labels.set(row.index, String(rank + 1));
  });
  return labels;
}

function buildLineMetaText(rows: LineStorageRow[]): string {
  const totalLengthKm = rows.reduce((sum, row) => sum + haversineKm(row.s_lat, row.s_lon, row.e_lat, row.e_lon), 0);
  const flightHours = totalLengthKm / (AIRCRAFT_SPEED_KNOTS * KNOT_TO_KMH);
  const turnHours = (rows.length * TURN_MINUTES_PER_LINE) / 60;
  const totalCaptureHours = flightHours + turnHours;
  return `${rows.length}개 라인 · 총길이 ${totalLengthKm.toFixed(1)}km · 총촬영시간 : 대략 ${totalCaptureHours.toFixed(1)}시간`;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const lat1Rad = degreesToRadians(lat1);
  const lat2Rad = degreesToRadians(lat2);
  const deltaLat = degreesToRadians(lat2 - lat1);
  const deltaLon = degreesToRadians(lon2 - lon1);
  const a =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function formatLinesAsText(rows: LineStorageRow[], projectName: string): string {
  const lines: string[] = [];
  if (projectName) {
    lines.push(`프로젝트: ${projectName}`);
    lines.push("=".repeat(70));
  }
  lines.push("Line  구분   위도                      경도");
  lines.push("-".repeat(70));
  rows.forEach((row) => {
    const lineLabel = row.num || "-";
    lines.push(`${lineLabel}  시작  ${ddToDms(row.s_lat, true)}  ${ddToDms(row.s_lon, false)}`);
    lines.push(`      끝    ${ddToDms(row.e_lat, true)}  ${ddToDms(row.e_lon, false)}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

function formatPolygonText(projectName: string): string {
  if (!projectName) {
    return POLYGON_ONLY_MESSAGE;
  }
  return `프로젝트: ${projectName}\n${"=".repeat(70)}\n${POLYGON_ONLY_MESSAGE}`;
}

function ddToDms(value: number, isLatitude: boolean): string {
  const direction = isLatitude ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  const abs = Math.abs(value);
  const totalCentiseconds = Math.round(abs * 3600 * 100);
  const degree = Math.floor(totalCentiseconds / (3600 * 100));
  const remaining = totalCentiseconds % (3600 * 100);
  const minute = Math.floor(remaining / (60 * 100));
  const second = (remaining % (60 * 100)) / 100;
  return `${degree}°${String(minute).padStart(2, "0")}'${second.toFixed(2).padStart(5, "0")}"${direction}`;
}

function extractFeatureName(feature: Feature<Geometry>): string {
  const properties = feature.properties ?? {};
  const rawName =
    properties.name ??
    properties.Name ??
    properties.title ??
    properties.id ??
    "";
  return typeof rawName === "string" ? rawName.trim() : String(rawName || "").trim();
}

function extractProjectName(fileName: string): string {
  const cleaned = String(fileName || "upload.kml").trim();
  if (!cleaned) {
    return "DOO_EXTRACTOR";
  }
  const withoutExtension = cleaned.replace(/\.[^/.]+$/, "");
  return withoutExtension || "DOO_EXTRACTOR";
}

function toLonLat(position: Position): [number, number] | null {
  if (!Array.isArray(position) || position.length < 2) {
    return null;
  }
  const lon = Number(position[0]);
  const lat = Number(position[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return null;
  }
  return [lon, lat];
}

function roundCoordinate(value: number): number {
  return Number(value.toFixed(6));
}

function isLineGeometry(geometry: Geometry): geometry is LineString | MultiLineString {
  return geometry.type === "LineString" || geometry.type === "MultiLineString";
}

function isPolygonGeometry(geometry: Geometry): geometry is Polygon | MultiPolygon {
  return geometry.type === "Polygon" || geometry.type === "MultiPolygon";
}
