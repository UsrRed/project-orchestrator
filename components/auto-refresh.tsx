"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Rafraîchit la page (Server Components) à intervalle régulier tant qu'il est
 * monté — utilisé quand un run autonome est actif, pour que le journal et le
 * tableau de bord se remplissent « tout seuls » sans que l'utilisateur recharge.
 *
 * Pausé quand l'onglet est caché (même esprit que le polling du HUD live), pour
 * ne pas rafraîchir dans le vide.
 */
export function AutoRefresh({ intervalMs = 3000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);

  return null;
}
