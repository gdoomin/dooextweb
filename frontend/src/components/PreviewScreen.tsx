"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { MapPreview } from "@/components/MapPreview";
import { type ConvertResponse, loadLastConvert } from "@/lib/convert";

const modeLabel = {
  linestring: "라인",
  polygon: "폴리곤",
} as const;

export function PreviewScreen() {
  const [data] = useState<ConvertResponse | null>(() => loadLastConvert());

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }
  }, []);

  if (!data) {
    return (
      <main className="min-h-screen bg-[linear-gradient(160deg,_#dde6f2_0%,_#f5f7fb_100%)] px-6 py-10 text-slate-900">
        <section className="mx-auto flex max-w-4xl flex-col gap-6 rounded-[32px] border border-slate-200 bg-white p-8 shadow-[0_24px_80px_rgba(33,47,85,0.12)]">
          <h1 className="text-3xl font-semibold tracking-tight">지도 미리보기</h1>
          <p className="text-base leading-7 text-slate-600">
            아직 미리보기 데이터가 없습니다. 먼저 메인 화면에서 KML 파일을 업로드한 뒤 다시 열어 주세요.
          </p>
          <div>
            <Link
              href="/"
              className="inline-flex h-12 items-center justify-center rounded-2xl bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-sky-700"
            >
              메인으로 돌아가기
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[linear-gradient(160deg,_#dde6f2_0%,_#f5f7fb_100%)] px-6 py-8 text-slate-900 lg:px-8">
      <section className="mx-auto grid max-w-7xl gap-6 xl:grid-cols-[0.34fr_0.66fr]">
        <aside className="grid gap-4 rounded-[30px] border border-slate-200 bg-white p-6 shadow-[0_20px_80px_rgba(33,47,85,0.12)] xl:max-h-[calc(100vh-4rem)] xl:overflow-auto">
          <div className="sticky top-0 z-20 -mx-2 space-y-2 rounded-2xl bg-white/95 px-2 py-1 backdrop-blur supports-[backdrop-filter]:bg-white/85">
            <h1 className="text-3xl font-semibold tracking-tight">지도 미리보기</h1>
            <p className="text-sm leading-6 text-slate-600">업로드 직후 받은 map payload를 기준으로 라인 또는 폴리곤을 지도에 표시합니다.</p>
          </div>

          <SummaryCard label="프로젝트" value={data.project_name} />
          <SummaryCard label="원본 파일" value={data.filename} />
          <SummaryCard label="모드" value={modeLabel[data.mode]} />
          <SummaryCard label="결과 개수" value={`${data.result_count}개`} />
          <SummaryCard label="지도 데이터" value={data.map_payload.meta_text || "-"} />

          <div className="rounded-[24px] bg-slate-950 px-5 py-5 text-sm text-slate-200">
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">현재 상태</div>
            <ul className="space-y-2 leading-6 text-slate-300">
              <li>1. 기본 지도 미리보기 렌더링 가능</li>
              <li>2. 메인 화면 변환 결과와 연결</li>
              <li>3. 상세 도식화는 별도 Viewer에서 열림</li>
            </ul>
          </div>

          <div className="flex gap-3">
            <Link
              href="/"
              className="inline-flex h-12 items-center justify-center rounded-2xl bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-sky-700"
            >
              메인으로 돌아가기
            </Link>
          </div>
        </aside>

        <section className="overflow-hidden rounded-[30px] border border-slate-200 bg-white p-4 shadow-[0_20px_80px_rgba(33,47,85,0.12)]">
          <MapPreview payload={data.map_payload} />
        </section>
      </section>
    </main>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[22px] border border-slate-200 bg-slate-50 px-4 py-4">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-2 break-words text-sm font-medium text-slate-900">{value}</div>
    </div>
  );
}
