"use client";

import { useEffect, useMemo, useState } from "react";

import { fetchPilotRecruitment, type PilotRecruitJobItem, type PilotRecruitmentResponse } from "@/lib/convert";

const JOB_UPDATED_AT_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatJobUpdatedAt(value: string): string {
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

function buildJobMetaText(item: PilotRecruitJobItem): string {
  const parts = [item.location || "", item.employment_type || "", item.experience || ""].filter(Boolean);
  return parts.join(" · ");
}

function buildDeadlineBadge(item: PilotRecruitJobItem): string {
  const dDay = String(item.d_day || "").trim();
  const deadlineText = String(item.deadline_text || "").trim();
  if (dDay) {
    return dDay;
  }
  return deadlineText || "채용중";
}

export function PilotJobsRailPanel() {
  const [payload, setPayload] = useState<PilotRecruitmentResponse>({
    items: [],
    source_label: "Airportal 항공일자리",
    updated_at: "",
    last_successful_at: "",
    last_attempted_at: "",
    cache_status: "",
    cache_warning: "",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError("");
      try {
        const next = await fetchPilotRecruitment();
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
  }, []);

  const items = payload.items || [];
  const updatedAtText = useMemo(
    () => formatJobUpdatedAt(payload.last_successful_at || payload.updated_at || ""),
    [payload.last_successful_at, payload.updated_at],
  );
  const attemptedAtText = useMemo(
    () => formatJobUpdatedAt(payload.last_attempted_at || ""),
    [payload.last_attempted_at],
  );
  const sourceLabel = String(payload.source_label || "Airportal 항공일자리").trim() || "Airportal 항공일자리";
  const isStaleCache = payload.cache_status === "stale";

  return (
    <section className="doo-rail-card doo-rail-card-jobs" aria-label="채용정보">
      <div className="doo-rail-jobs-summary">
        <strong>채용정보</strong>
        <div className="doo-rail-jobs-count">{loading ? "조회 중" : `${items.length}건`}</div>
      </div>
      <div className="doo-rail-jobs-meta">
        <span>운항승무원 · 조종사 관련 공고</span>
        <span>{sourceLabel}</span>
        <span>{updatedAtText ? `${isStaleCache ? "마지막 성공" : "업데이트"} ${updatedAtText}` : "최신 캐시 기준"}</span>
      </div>
      {isStaleCache ? (
        <div className="doo-rail-jobs-warning" role="status" aria-live="polite">
          <strong>이전 캐시 표시 중</strong>
          <span>{payload.cache_warning || "채용정보 원본 연결이 불안정해 마지막 성공 데이터를 보여주고 있습니다."}</span>
          {attemptedAtText ? <em>마지막 시도 {attemptedAtText}</em> : null}
        </div>
      ) : null}
      {error ? (
        <div className="doo-rail-jobs-empty">
          <strong>채용정보를 불러오지 못했습니다.</strong>
          <span>{error}</span>
        </div>
      ) : items.length ? (
        <div className="doo-rail-jobs-list">
          {items.map((item) => {
            const metaText = buildJobMetaText(item);
            const primaryKeyword = item.matched_keywords?.[0] || "조종사";
            return (
              <a
                key={item.id}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="doo-rail-job-card"
                title={item.title}
              >
                <div className="doo-rail-job-strip">
                  <span className="doo-rail-job-role">{primaryKeyword}</span>
                  <span className="doo-rail-job-runway">FLIGHT DECK</span>
                </div>
                <div className="doo-rail-job-top">
                  <strong className="doo-rail-job-company">{item.company || "항공 채용"}</strong>
                  <span className="doo-rail-job-deadline">{buildDeadlineBadge(item)}</span>
                </div>
                <div className="doo-rail-job-title">{item.title}</div>
                {metaText ? <div className="doo-rail-job-meta-line">{metaText}</div> : null}
                <div className="doo-rail-job-footer">
                  {item.matched_keywords?.length ? (
                    <div className="doo-rail-job-keywords">
                      {item.matched_keywords.slice(0, 3).map((keyword) => (
                        <span key={`${item.id}-${keyword}`} className="doo-rail-job-chip">
                          {keyword}
                        </span>
                      ))}
                    </div>
                  ) : <span />}
                  <span className="doo-rail-job-cta">원문 보기</span>
                </div>
              </a>
            );
          })}
        </div>
      ) : (
        <div className="doo-rail-jobs-empty">
          <strong>표시할 채용정보가 없습니다.</strong>
          <span>키워드에 맞는 조종사 관련 공고가 확인되면 이 영역에 표시됩니다.</span>
        </div>
      )}
    </section>
  );
}
