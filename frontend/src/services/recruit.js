"use client";

import { useEffect, useMemo, useState } from "react";

import { fetchPilotJobsPanel } from "@/lib/jobs-client";

/**
 * @typedef {import("@/lib/jobs-client").PilotJobListItem} PilotJobListItem
 * @typedef {import("@/lib/jobs-client").PilotRecruitmentResponse} PilotRecruitmentResponse
 */

const JOB_UPDATED_AT_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function createEmptyRecruitPayload() {
  /** @type {PilotRecruitmentResponse} */
  return {
    items: [],
    source_label: "Airportal 항공일자리",
    updated_at: "",
    last_successful_at: "",
    last_attempted_at: "",
    cache_status: "",
    cache_warning: "",
  };
}

export function formatRecruitUpdatedAt(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return JOB_UPDATED_AT_FORMATTER.format(parsed);
}

export function buildRecruitMetaText(item) {
  const experienceText = String(item.experience || "").trim();
  const shouldShowExperience =
    !!experienceText &&
    !/^\d+$/.test(experienceText) &&
    !/^[\d\s./-]+$/.test(experienceText);
  const parts = [item.location || "", item.employment_type || "", shouldShowExperience ? experienceText : ""].filter(Boolean);
  return parts.join(" · ");
}

export function buildRecruitDeadlineBadge(item) {
  const dDay = String(item.d_day || "").trim();
  const deadlineText = String(item.deadline_text || "").trim();
  if (dDay) {
    return dDay;
  }
  return deadlineText || "채용중";
}

export function useRecruitRailPanel(limit = 12) {
  const [payload, setPayload] = useState(createEmptyRecruitPayload);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError("");
      try {
        const next = await fetchPilotJobsPanel(limit);
        if (!cancelled) {
          setPayload(next);
        }
      } catch (fetchError) {
        if (!cancelled) {
          const message = fetchError instanceof Error ? fetchError.message : "채용정보를 불러오지 못했습니다.";
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [limit]);

  const items = payload.items || [];
  const updatedAtText = useMemo(
    () => formatRecruitUpdatedAt(payload.last_successful_at || payload.updated_at || ""),
    [payload.last_successful_at, payload.updated_at],
  );
  const attemptedAtText = useMemo(
    () => formatRecruitUpdatedAt(payload.last_attempted_at || ""),
    [payload.last_attempted_at],
  );
  const sourceLabel = String(payload.source_label || "Airportal 항공일자리").trim() || "Airportal 항공일자리";
  const isStaleCache = payload.cache_status === "stale";

  return {
    payload,
    items,
    loading,
    error,
    updatedAtText,
    attemptedAtText,
    sourceLabel,
    isStaleCache,
  };
}
