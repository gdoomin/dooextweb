import type { PilotJobListItem, PilotRecruitmentResponse } from "@/lib/jobs-client";

export function formatRecruitUpdatedAt(value: string): string;
export function buildRecruitMetaText(item: PilotJobListItem): string;
export function buildRecruitDeadlineBadge(item: PilotJobListItem): string;
export function useRecruitRailPanel(limit?: number): {
  payload: PilotRecruitmentResponse;
  items: PilotJobListItem[];
  loading: boolean;
  error: string;
  updatedAtText: string;
  attemptedAtText: string;
  sourceLabel: string;
  isStaleCache: boolean;
};
