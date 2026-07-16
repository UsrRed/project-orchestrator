import { NextResponse } from "next/server";

import { liveSnapshot } from "@/lib/live";
import { getCurrentUserId } from "@/lib/users";

export const dynamic = "force-dynamic";

/**
 * État live des agents pour le HUD flottant. Interrogé en boucle : on renvoie
 * 401 plutôt qu'une erreur 500 quand il n'y a pas de session, pour que le HUD
 * se taise simplement au lieu de bruiter les logs.
 */
export async function GET() {
  let userId: string;
  try {
    userId = await getCurrentUserId();
  } catch {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const snapshot = await liveSnapshot(userId);
  return NextResponse.json(snapshot, {
    headers: { "Cache-Control": "no-store" },
  });
}
