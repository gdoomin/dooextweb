"use client";

import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { NotamMiniMap } from "@/components/NotamMiniMap";

type BeforeFlightTab = {
  key: string;
  label: string;
};

const BEFORE_FLIGHT_TABS: BeforeFlightTab[] = [
  { key: "safety", label: "운항 안전 점검표" },
  { key: "notam", label: "NOTAM 확인" },
  { key: "weather", label: "기상 체크" },
  { key: "weight-balance", label: "Weight & Balance" },
  { key: "flight-plan", label: "Flgiht plan" },
];

const SAFETY_CHECKLIST_ITEMS = [
  "운항과 관련된 인허가 사항 확인.",
  "기상 및 NOTAM 확인.",
  "Weight & Balance 확인.",
  "비행계획 제출 확인.",
  "비행 전 브리핑 실시.",
  "조종사 건강 상태",
  "1. 비행 12시간이내 음주여부 확인.",
  "2. 약물 복용 여부 확인.",
  "3. 기타 정신적 신체적 적성여부 확인.",
  "해당 자격증, 신체검사증명서 및 안경(해당자)등 비행에 필요한 조종사 휴대품 확인.",
  "항공기 탑재서류 및 인허가 사항 확인.",
  "항공기 점검 확인.",
];

const BEFORE_FLIGHT_LOGO_STORAGE_KEY = "doo-before-flight-logo-src";
const BEFORE_FLIGHT_DEFAULT_LOGO_SRC = "/ksgt-logo-default.jpg";

export default function BeforeFlightPage() {
  const [activeTab, setActiveTab] = useState<string>(BEFORE_FLIGHT_TABS[0]?.key ?? "safety");
  const [flightDate, setFlightDate] = useState<string>("");
  const [authorName, setAuthorName] = useState<string>("");
  const [captainName, setCaptainName] = useState<string>("");
  const [firstOfficerName, setFirstOfficerName] = useState<string>("");
  const [callSign, setCallSign] = useState<string>("HL5119");
  const [notes, setNotes] = useState<string>("");
  const [logoSrc, setLogoSrc] = useState<string>(BEFORE_FLIGHT_DEFAULT_LOGO_SRC);
  const [logoModalOpen, setLogoModalOpen] = useState<boolean>(false);

  const logoFileInputRef = useRef<HTMLInputElement | null>(null);

  const activeLabel = useMemo(
    () => BEFORE_FLIGHT_TABS.find((tab) => tab.key === activeTab)?.label ?? BEFORE_FLIGHT_TABS[0].label,
    [activeTab],
  );

  const weekdayLabel = useMemo(() => {
    if (!flightDate) {
      return "";
    }
    const parsedDate = new Date(`${flightDate}T00:00:00`);
    if (Number.isNaN(parsedDate.getTime())) {
      return "";
    }
    return new Intl.DateTimeFormat("ko-KR", { weekday: "short" }).format(parsedDate);
  }, [flightDate]);

  useEffect(() => {
    try {
      const savedLogoSrc = window.localStorage.getItem(BEFORE_FLIGHT_LOGO_STORAGE_KEY);
      if (savedLogoSrc) {
        setLogoSrc(savedLogoSrc);
      }
    } catch {
      setLogoSrc(BEFORE_FLIGHT_DEFAULT_LOGO_SRC);
    }
  }, []);

  function handlePrint() {
    window.print();
  }

  function handleLogoFilePickerOpen() {
    logoFileInputRef.current?.click();
  }

  function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) {
      return;
    }
    if (!selectedFile.type.startsWith("image/")) {
      window.alert("이미지 파일만 선택할 수 있습니다.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result) {
        return;
      }
      setLogoSrc(result);
      try {
        window.localStorage.setItem(BEFORE_FLIGHT_LOGO_STORAGE_KEY, result);
      } catch {
        window.alert("로컬 저장공간이 부족하여 이미지를 저장하지 못했습니다.");
      }
    };
    reader.readAsDataURL(selectedFile);

    // 같은 파일을 연속 선택해도 onChange가 동작하도록 초기화
    event.target.value = "";
  }

  function handleLogoReset() {
    setLogoSrc(BEFORE_FLIGHT_DEFAULT_LOGO_SRC);
    try {
      window.localStorage.removeItem(BEFORE_FLIGHT_LOGO_STORAGE_KEY);
    } catch {
      // no-op
    }
  }

  return (
    <main className="doo-before-flight-page">
      <section className="doo-before-flight-shell">
        <header className="doo-before-flight-head">
          <h1>비행준비(Before Flight)</h1>
          <p>운항 전 준비 항목을 탭으로 확인할 수 있습니다.</p>
        </header>

        <div className="doo-before-flight-tabs" role="tablist" aria-label="비행준비 탭">
          {BEFORE_FLIGHT_TABS.map((tab) => {
            const isActive = tab.key === activeTab;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`doo-before-flight-tab${isActive ? " is-active" : ""}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {activeTab === "safety" ? (
          <section className="doo-before-flight-content doo-before-flight-safety-panel" role="tabpanel" aria-live="polite">
            <div className="doo-safety-actions doo-safety-actions-top">
              <button type="button" className="doo-safety-print-button" onClick={handlePrint}>
                print
              </button>
            </div>

            <article className="doo-safety-sheet" aria-label="KSGT 운항 안전 점검표">
              <div className="doo-safety-sheet-brand-row">
                <button
                  type="button"
                  className="doo-safety-logo-button"
                  onClick={() => setLogoModalOpen(true)}
                  title="로고 보기/변경"
                >
                  <img src={logoSrc} alt="KSGT 로고" className="doo-safety-logo-image" />
                </button>
                <label className="doo-safety-callsign-wrap">
                  <span>호출부호 :</span>
                  <input
                    type="text"
                    value={callSign}
                    onChange={(event) => setCallSign(event.target.value)}
                    className="doo-safety-input doo-safety-callsign-input"
                    aria-label="호출부호 입력"
                  />
                </label>
              </div>

              <div className="doo-safety-sheet-head">
                <h2>비행 전 운항 안전 점검표</h2>
              </div>

              <table className="doo-safety-table">
                <colgroup>
                  <col className="col-a" />
                  <col className="col-b" />
                  <col className="col-c" />
                  <col className="col-d" />
                  <col className="col-e" />
                  <col className="col-f" />
                  <col className="col-g" />
                </colgroup>
                <tbody>
                  <tr>
                    <th>운항일자</th>
                    <td colSpan={2}>
                      <div className="doo-safety-date-input-wrap">
                        <input
                          type="date"
                          value={flightDate}
                          onChange={(event) => setFlightDate(event.target.value)}
                          className="doo-safety-input"
                          aria-label="운항일자 입력"
                        />
                        <span className="doo-safety-date-weekday">{weekdayLabel ? `(${weekdayLabel})` : ""}</span>
                      </div>
                    </td>
                    <th colSpan={2}>작성자</th>
                    <td colSpan={2}>
                      <input
                        type="text"
                        value={authorName}
                        onChange={(event) => setAuthorName(event.target.value)}
                        className="doo-safety-input"
                        placeholder="작성자 입력"
                        aria-label="작성자 입력"
                      />
                    </td>
                  </tr>

                  <tr>
                    <th colSpan={3} rowSpan={4} className="doo-safety-check-heading">
                      점 검 사 항
                    </th>
                    <th colSpan={2}>기 장</th>
                    <th colSpan={2}>부 기 장</th>
                  </tr>

                  <tr>
                    <th>성명</th>
                    <td>
                      <input
                        type="text"
                        value={captainName}
                        onChange={(event) => setCaptainName(event.target.value)}
                        className="doo-safety-input"
                        placeholder="기장 성명"
                        aria-label="기장 성명 입력"
                      />
                    </td>
                    <th>성명</th>
                    <td>
                      <input
                        type="text"
                        value={firstOfficerName}
                        onChange={(event) => setFirstOfficerName(event.target.value)}
                        className="doo-safety-input"
                        placeholder="부기장 성명"
                        aria-label="부기장 성명 입력"
                      />
                    </td>
                  </tr>

                  <tr>
                    <th>서명</th>
                    <td />
                    <th>서명</th>
                    <td />
                  </tr>

                  <tr>
                    <th colSpan={2}>상 태</th>
                    <th colSpan={2}>상 태</th>
                  </tr>

                  {SAFETY_CHECKLIST_ITEMS.map((item) => (
                    <tr key={item}>
                      <td colSpan={3} className="doo-safety-item-cell">
                        {item}
                      </td>
                      <td colSpan={2} />
                      <td colSpan={2} />
                    </tr>
                  ))}

                  <tr>
                    <th>기타사항</th>
                    <td colSpan={6}>
                      <textarea
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                        className="doo-safety-textarea"
                        placeholder="기타사항 입력"
                        rows={4}
                        aria-label="기타사항 입력"
                      />
                    </td>
                  </tr>
                </tbody>
              </table>
            </article>

            <div className="doo-safety-actions doo-safety-actions-bottom">
              <button type="button" className="doo-safety-print-button" onClick={handlePrint}>
                print
              </button>
            </div>
          </section>
        ) : activeTab === "notam" ? (
          <section className="doo-before-flight-content doo-before-flight-notam-panel" role="tabpanel" aria-live="polite">
            <NotamMiniMap mode="beforeFlight" />
          </section>
        ) : (
          <section className="doo-before-flight-content" role="tabpanel" aria-live="polite">
            <h2>{activeLabel}</h2>
            <p>준비중</p>
          </section>
        )}
      </section>

      <input
        ref={logoFileInputRef}
        type="file"
        accept="image/*"
        className="doo-safety-logo-file-input"
        onChange={handleLogoFileChange}
      />

      {logoModalOpen ? (
        <div className="doo-safety-logo-modal-backdrop" role="dialog" aria-modal="true" aria-label="로고 이미지 보기">
          <div className="doo-safety-logo-modal">
            <img src={logoSrc} alt="로고 미리보기" className="doo-safety-logo-modal-image" />
            <div className="doo-safety-logo-modal-actions">
              <button type="button" className="doo-safety-logo-modal-button" onClick={handleLogoFilePickerOpen}>
                사진 바꾸기
              </button>
              <button type="button" className="doo-safety-logo-modal-button" onClick={handleLogoReset}>
                기본 로고
              </button>
              <button
                type="button"
                className="doo-safety-logo-modal-button is-close"
                onClick={() => setLogoModalOpen(false)}
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
