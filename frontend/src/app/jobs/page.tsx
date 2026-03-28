import type { Metadata } from "next";
import Link from "next/link";

import { fetchPilotJobsIndex, type JobsFilterOption, type PilotJobListItem } from "@/lib/jobs-client";

export const metadata: Metadata = {
  title: "Pilot Jobs Portal",
  description: "조종사, 기장, 부기장, 비행교관 채용정보를 한곳에서 찾는 항공 채용 포털",
};

export const dynamic = "force-dynamic";

type SearchParamValue = string | string[] | undefined;

type JobsPageProps = {
  searchParams?: Promise<Record<string, SearchParamValue>>;
};

const ROLE_LABELS: Record<string, string> = {
  pilot: "조종사",
  captain: "기장",
  first_officer: "부기장",
  flight_instructor: "비행교관",
  cadet: "Cadet",
  helicopter_pilot: "회전익 조종사",
  special_mission_pilot: "특수운항 조종사",
  other_flight_crew: "운항승무원",
};

const JOB_UPDATED_AT_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function firstValue(value: SearchParamValue) {
  if (Array.isArray(value)) {
    return String(value[0] || "").trim();
  }
  return String(value || "").trim();
}

function toPositiveInt(value: SearchParamValue, fallback: number) {
  const parsed = Number(firstValue(value));
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}

function formatUpdatedAt(value: string) {
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

function buildJobsHref(params: Record<string, string | number | undefined>) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    const text = String(value ?? "").trim();
    if (!text) {
      return;
    }
    searchParams.set(key, text);
  });
  const query = searchParams.toString();
  return query ? `/jobs?${query}` : "/jobs";
}

function buildMetaLine(item: PilotJobListItem) {
  return [item.location || "", item.employment_type || "", item.experience || ""].filter(Boolean).join(" · ");
}

function buildJobBadge(item: PilotJobListItem) {
  const roleKey = String(item.role_family || "").trim();
  if (roleKey && ROLE_LABELS[roleKey]) {
    return ROLE_LABELS[roleKey];
  }
  return item.matched_keywords?.[0] || "조종사";
}

function buildPageTitle(totalCount: number, query: string) {
  if (query) {
    return `"${query}" 검색 결과 ${totalCount}건`;
  }
  return `전체 공고 ${totalCount}건`;
}

function FilterSelect({
  name,
  value,
  options,
  placeholder,
}: {
  name: string;
  value: string;
  options: JobsFilterOption[];
  placeholder: string;
}) {
  return (
    <label className="jobs-filter-field">
      <span>{placeholder}</span>
      <select name={name} defaultValue={value}>
        <option value="">{placeholder} 전체</option>
        {options.map((option) => (
          <option key={`${name}-${option.value}`} value={option.value}>
            {option.label} ({option.count})
          </option>
        ))}
      </select>
    </label>
  );
}

export default async function JobsPage({ searchParams }: JobsPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const q = firstValue(resolvedSearchParams.q);
  const roleFamily = firstValue(resolvedSearchParams.role_family);
  const location = firstValue(resolvedSearchParams.location);
  const employmentType = firstValue(resolvedSearchParams.employment_type);
  const page = toPositiveInt(resolvedSearchParams.page, 1);
  const limit = 24;

  let payload: Awaited<ReturnType<typeof fetchPilotJobsIndex>> | null = null;
  let errorMessage = "";

  try {
    payload = await fetchPilotJobsIndex({
      q,
      role_family: roleFamily,
      location,
      employment_type: employmentType,
      page,
      limit,
    });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "채용 목록을 불러오지 못했습니다.";
  }

  const totalCount = payload?.total_count ?? 0;
  const updatedAtText = formatUpdatedAt(payload?.last_successful_at || payload?.updated_at || "");
  const attemptedAtText = formatUpdatedAt(payload?.last_attempted_at || "");
  const previousPageHref = page > 1
    ? buildJobsHref({
        q,
        role_family: roleFamily,
        location,
        employment_type: employmentType,
        page: page - 1,
      })
    : "";
  const nextPageHref = payload?.has_more
    ? buildJobsHref({
        q,
        role_family: roleFamily,
        location,
        employment_type: employmentType,
        page: page + 1,
      })
    : "";

  return (
    <main className="jobs-portal-shell">
      <section className="jobs-portal-hero">
        <div className="jobs-portal-topline">
          <span className="jobs-portal-badge">FLIGHT CREW PORTAL</span>
          <Link href="/" className="jobs-portal-home-link">
            홈으로
          </Link>
        </div>
        <div className="jobs-portal-hero-copy">
          <h1>조종계열 채용 포털</h1>
          <p>조종사, 기장, 부기장, Cadet, 비행교관 공고를 역할과 자격 기준으로 한 번에 찾을 수 있도록 정리했습니다.</p>
        </div>

        <form method="get" className="jobs-search-panel">
          <label className="jobs-search-field jobs-search-field-wide">
            <span>검색</span>
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="회사명, 기종, 조종사, 부기장, 비행교관"
            />
          </label>

          <FilterSelect
            name="role_family"
            value={roleFamily}
            options={payload?.filters.role_families ?? []}
            placeholder="직무"
          />
          <FilterSelect
            name="location"
            value={location}
            options={payload?.filters.locations ?? []}
            placeholder="지역"
          />
          <FilterSelect
            name="employment_type"
            value={employmentType}
            options={payload?.filters.employment_types ?? []}
            placeholder="고용형태"
          />

          <div className="jobs-search-actions">
            <button type="submit" className="jobs-search-submit">
              검색
            </button>
            <Link href="/jobs" className="jobs-search-reset">
              초기화
            </Link>
          </div>
        </form>

        <div className="jobs-portal-status">
          <div className="jobs-portal-status-copy">
            <strong>{buildPageTitle(totalCount, q)}</strong>
            <span>{payload?.source_label || "채용정보 소스"}</span>
          </div>
          <div className="jobs-portal-status-meta">
            <span>{updatedAtText ? `마지막 성공 ${updatedAtText}` : "최신 시각 확인 중"}</span>
            <span>{payload?.cache_status === "stale" && attemptedAtText ? `마지막 시도 ${attemptedAtText}` : "실시간 목록"}</span>
          </div>
        </div>
      </section>

      {payload?.cache_status === "stale" ? (
        <section className="jobs-portal-warning">
          <strong>이전 캐시 표시 중</strong>
          <span>{payload.cache_warning || "수집 소스가 불안정해 마지막 성공 데이터를 표시하고 있습니다."}</span>
        </section>
      ) : null}

      {errorMessage ? (
        <section className="jobs-empty-state">
          <strong>채용 목록을 불러오지 못했습니다.</strong>
          <span>{errorMessage}</span>
        </section>
      ) : null}

      {!errorMessage && payload && !payload.items.length ? (
        <section className="jobs-empty-state">
          <strong>조건에 맞는 공고가 없습니다.</strong>
          <span>검색어를 줄이거나 직무·지역 필터를 초기화한 뒤 다시 확인해 보세요.</span>
        </section>
      ) : null}

      {!errorMessage && payload && payload.items.length ? (
        <>
          <section className="jobs-results-grid">
            {payload.items.map((item) => {
              const metaLine = buildMetaLine(item);
              const chips = [
                buildJobBadge(item),
                ...(item.license_tags || []).slice(0, 2),
                ...(item.aircraft_types || []).slice(0, 2),
              ].filter(Boolean);

              return (
                <article key={item.id} className="jobs-card">
                  <div className="jobs-card-top">
                    <div className="jobs-card-company-wrap">
                      <span className="jobs-card-company">{item.company}</span>
                      <span className="jobs-card-source">{item.source}</span>
                    </div>
                    <span className="jobs-card-deadline">{item.d_day || item.deadline_text || "채용중"}</span>
                  </div>

                  <h2 className="jobs-card-title">{item.title}</h2>
                  {metaLine ? <p className="jobs-card-meta">{metaLine}</p> : null}
                  {item.summary ? <p className="jobs-card-summary">{item.summary}</p> : null}

                  {chips.length ? (
                    <div className="jobs-card-chips">
                      {chips.map((chip) => (
                        <span key={`${item.id}-${chip}`} className="jobs-card-chip">
                          {chip}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  <div className="jobs-card-footer">
                    <div className="jobs-card-dates">
                      {item.deadline_date ? <span>마감 {item.deadline_date}</span> : <span>상시채용</span>}
                      {item.posted_at ? <span>수집 {formatUpdatedAt(item.posted_at)}</span> : null}
                    </div>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="jobs-card-link"
                    >
                      원문 보기
                    </a>
                  </div>
                </article>
              );
            })}
          </section>

          <nav className="jobs-pagination" aria-label="채용 목록 페이지 이동">
            {previousPageHref ? (
              <Link href={previousPageHref} className="jobs-page-button">
                이전 페이지
              </Link>
            ) : (
              <span className="jobs-page-button is-disabled">이전 페이지</span>
            )}
            <span className="jobs-page-indicator">{page} 페이지</span>
            {nextPageHref ? (
              <Link href={nextPageHref} className="jobs-page-button">
                다음 페이지
              </Link>
            ) : (
              <span className="jobs-page-button is-disabled">다음 페이지</span>
            )}
          </nav>
        </>
      ) : null}
    </main>
  );
}
