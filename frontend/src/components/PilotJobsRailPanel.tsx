"use client";

import Link from "next/link";
import { buildRecruitDeadlineBadge, buildRecruitMetaText, useRecruitRailPanel } from "@/services/recruit";

export function PilotJobsRailPanel() {
  const { payload, items, loading, error, updatedAtText, attemptedAtText, sourceLabel, isStaleCache } =
    useRecruitRailPanel();

  return (
    <section className="doo-rail-card doo-rail-card-jobs" aria-label="채용정보">
      <div className="doo-rail-jobs-summary">
        <div className="doo-rail-jobs-summary-copy">
          <strong>채용정보</strong>
          <span>조종계열 공고 허브</span>
        </div>
        <div className="doo-rail-jobs-summary-actions">
          <Link href="/jobs" className="doo-rail-jobs-link">
            전체 보기
          </Link>
          <div className="doo-rail-jobs-count">{loading ? "조회 중" : `${items.length}건`}</div>
        </div>
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
            const metaText = buildRecruitMetaText(item);
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
                  <span className="doo-rail-job-deadline">{buildRecruitDeadlineBadge(item)}</span>
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
