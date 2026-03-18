export type LineResult = {
  num?: string;
  force_label?: string;
  force_order?: number;
  s_lat?: number;
  s_lon?: number;
  e_lat?: number;
  e_lon?: number;
  s_text?: string;
  e_text?: string;
};

export type PolygonResult = {
  num?: string;
  label?: string;
  points: [number, number][];
};

export type MapPayload = {
  project_name: string;
  mode: "linestring" | "polygon";
  results: LineResult[];
  polygons: PolygonResult[];
  has_kml_num?: boolean;
  default_force_num?: boolean;
  default_show_num?: boolean;
  has_layers?: boolean;
  layer_catalog?: Array<Record<string, unknown>>;
  default_gray_map?: boolean;
  meta_text?: string;
};

export type ConvertResponse = {
  ok: boolean;
  filename: string;
  project_name: string;
  mode: "linestring" | "polygon";
  result_count: number;
  text_output: string;
  map_payload: MapPayload;
  results: Array<Record<string, unknown>>;
  job_id: string;
  viewer_url: string;
  txt_download_url: string;
  xlsx_download_url: string;
};

const STORAGE_KEY = "doo-extractor-last-convert";

export function saveLastConvert(payload: ConvertResponse) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function loadLastConvert(): ConvertResponse | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as ConvertResponse;
  } catch {
    return null;
  }
}
