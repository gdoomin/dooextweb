"use client";

import { useEffect } from "react";
import { getRecoveryRedirect } from "@/lib/password-recovery";

export function AuthRecoveryRedirect() {
  useEffect(() => {
    const target = getRecoveryRedirect(new URL(window.location.href));
    if (target) window.location.replace(target);
  }, []);
  return null;
}
