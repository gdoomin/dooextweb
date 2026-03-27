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
  container?: HTMLElement | string;
};

declare global {
  interface Window {
    PartnersCoupang?: {
      G: new (config: CoupangConfig) => unknown;
    };
  }
}

const COUPANG_SCRIPT_ID = "doo-coupang-partners-sdk";
const COUPANG_BASE_CONFIG: CoupangConfig = {
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
  const lastRenderedHeightRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;
    let resizeFrame = 0;
    let resizeObserver: ResizeObserver | null = null;
    const container = containerRef.current;

    const resolveAdHeight = () => {
      if (!container || typeof window === "undefined") {
        return minHeight;
      }

      const rect = container.getBoundingClientRect();
      const measuredHeight = Math.max(
        Math.floor(container.clientHeight || 0),
        Math.floor(rect.height || 0),
        minHeight,
      );
      return measuredHeight;
    };

    const renderAd = async (force = false) => {
      if (!container || typeof window === "undefined") {
        return;
      }

      const height = resolveAdHeight();
      if (!force && Math.abs(height - lastRenderedHeightRef.current) < 4) {
        return;
      }
      lastRenderedHeightRef.current = height;
      container.innerHTML = "";

      try {
        await ensureCoupangSdk();
        if (cancelled) {
          return;
        }

        if (!window.PartnersCoupang?.G) {
          throw new Error("쿠팡 광고 생성기를 찾을 수 없습니다.");
        }

        new window.PartnersCoupang.G({
          ...COUPANG_BASE_CONFIG,
          height: String(height),
          container,
        });
      } catch {
        if (cancelled) {
          return;
        }
        container.innerHTML = '<div class="doo-ad-placeholder">광고를 불러오지 못했습니다.</div>';
      }
    };

    const scheduleRender = (force = false) => {
      if (typeof window === "undefined") {
        return;
      }
      if (resizeFrame) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        void renderAd(force);
      });
    };

    void renderAd(true);

    if (typeof ResizeObserver !== "undefined" && container) {
      resizeObserver = new ResizeObserver(() => {
        scheduleRender();
      });
      resizeObserver.observe(container);
      if (container.parentElement) {
        resizeObserver.observe(container.parentElement);
      }
    } else if (typeof window !== "undefined") {
      const handleResize = () => {
        scheduleRender();
      };
      window.addEventListener("resize", handleResize);
      return () => {
        cancelled = true;
        if (resizeFrame) {
          window.cancelAnimationFrame(resizeFrame);
        }
        window.removeEventListener("resize", handleResize);
        if (container) {
          container.innerHTML = "";
        }
      };
    }

    return () => {
      cancelled = true;
      if (resizeFrame && typeof window !== "undefined") {
        window.cancelAnimationFrame(resizeFrame);
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (container) {
        container.innerHTML = "";
      }
    };
  }, [minHeight]);

  return (
    <div
      ref={containerRef}
      className={`doo-coupang-slot ${className}`.trim()}
      style={{ minHeight, height: "100%" }}
    />
  );
}
