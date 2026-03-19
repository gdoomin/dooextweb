"use client";

import { useEffect, useRef } from "react";

type AdSenseSlotProps = {
  slot: string;
  className?: string;
  minHeight?: number;
};

const ADSENSE_CLIENT = "ca-pub-7599505823176898";

export function AdSenseSlot({ slot, className = "", minHeight = 90 }: AdSenseSlotProps) {
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!slot || initializedRef.current || typeof window === "undefined") {
      return;
    }
    initializedRef.current = true;
    try {
      const queue = (window as Window & { adsbygoogle?: unknown[] }).adsbygoogle || [];
      queue.push({});
      (window as Window & { adsbygoogle?: unknown[] }).adsbygoogle = queue;
    } catch {
      initializedRef.current = false;
    }
  }, [slot]);

  if (!slot) {
    return <div className={`doo-ad-placeholder ${className}`.trim()}>Ad slot is not configured.</div>;
  }

  return (
    <ins
      className={`adsbygoogle ${className}`.trim()}
      style={{ display: "block", minHeight }}
      data-ad-client={ADSENSE_CLIENT}
      data-ad-slot={slot}
      data-ad-format="auto"
      data-full-width-responsive="true"
    />
  );
}
