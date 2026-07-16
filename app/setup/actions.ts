"use server";

import { revalidatePath } from "next/cache";

import {
  isGitHubConfigured,
  setGitHubOAuthConfig,
} from "@/lib/oauth-config";

export interface SetupState {
  ok: boolean;
  message: string;
}

function devOpen(): boolean {
  return (
    process.env.ALLOW_DEV_USER === "true" ||
    process.env.NODE_ENV !== "production"
  );
}

/**
 * Enregistre les creds de l'OAuth App GitHub. Garde-fou : la modification
 * n'est autorisée qu'au premier paramétrage (aucune config), en dev, ou pour
 * un utilisateur déjà authentifié — sinon on refuse (évite qu'un tiers écrase
 * la config une fois l'app en production).
 */
export async function saveGitHubOAuthAction(
  _prev: SetupState,
  formData: FormData,
): Promise<SetupState> {
  const clientId = String(formData.get("clientId") ?? "").trim();
  const clientSecret = String(formData.get("clientSecret") ?? "").trim();
  if (!clientId || !clientSecret) {
    return { ok: false, message: "Client ID et Client Secret requis." };
  }

  const already = await isGitHubConfigured();
  let authed = false;
  try {
    const { auth } = await import("@/auth");
    authed = Boolean((await auth())?.user);
  } catch {
    // hors contexte
  }

  if (already && !authed && !devOpen()) {
    return {
      ok: false,
      message:
        "OAuth déjà configuré. Connecte-toi pour modifier les identifiants.",
    };
  }

  try {
    await setGitHubOAuthConfig(clientId, clientSecret);
    revalidatePath("/setup");
    revalidatePath("/signin");
    return {
      ok: true,
      message:
        "Identifiants enregistrés (secret chiffré). Tu peux te connecter avec GitHub.",
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Erreur d'enregistrement.",
    };
  }
}
