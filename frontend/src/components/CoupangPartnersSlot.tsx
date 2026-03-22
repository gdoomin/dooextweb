"use client";

import { useEffect, useRef } from "react";

type CoupangPartnersSlotProps = {
  className?: string;
  minHeight?: number;
};

type CoupangConfig = {
  id: number;
  template: string;
  trackingCode: string;
  width: string;
  height: string;
  tsource: string;
};

declare global {
  interface Window {
    PartnersCoupang?: {
      G: new (config: CoupangConfig) => unknown;
    };
  }
}

const COUPANG_SCRIPT_ID = "doo-coupang-partners-sdk";
const COUPANG_CONFIG: CoupangConfig = {
  id: 974526,
  template: "carousel",
  trackingCode: "AF3646154",
  width: "320",
  height: "650",
  tsource: "",
};

function ensureCoupangSdk(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }
  if (window.PartnersCoupang?.G) {
    return Promise.resolve();
  }

  const existing = document.getElementById(COUPANG_SCRIPT_ID) as HTMLScriptElement | null;
  if (existing) {
    return new Promise((resolve, reject) => {
      const handleLoad = () => resolve();
      const handleError = () => reject(new Error("쿠팡 광고 스크립트를 불러오지 못했습니다."));
      existing.addEventListener("load", handleLoad, { once: true });
      existing.addEventListener("error", handleError, { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.id = COUPANG_SCRIPT_ID;
    script.src = "https://ads-partners.coupang.com/g.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("쿠팡 광고 스크립트를 불러오지 못했습니다."));
    document.head.appendChild(script);
  });
}

export function CoupangPartnersSlot({ className = "", minHeight = 650 }: CoupangPartnersSlotProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;

    const renderAd = async () => {
      if (!container || typeof window === "undefined") {
        return;
      }

      container.innerHTML = "";

      try {
        await ensureCoupangSdk();
        if (cancelled) {
          return;
        }

        const inlineScript = document.createElement("script");
        inlineScript.text = `new PartnersCoupang.G(${JSON.stringify(COUPANG_CONFIG)});`;
        container.appendChild(inlineScript);
      } catch {
        if (cancelled) {
          return;
        }
        container.innerHTML = '<div class="doo-ad-placeholder">광고를 불러오지 못했습니다.</div>';
      }
    };

    void renderAd();

    return () => {
      cancelled = true;
      if (container) {
        container.innerHTML = "";
      }
    };
  }, []);

  return <div ref={containerRef} className={`doo-coupang-slot ${className}`.trim()} style={{ minHeight }} />;
}
