"use server";

import { revalidatePath } from "next/cache";

import { upsertProfile } from "@/lib/profile";
import { getCurrentUserId } from "@/lib/users";
import type { Provider } from "@/lib/models";
import type { ProjectType } from "@/lib/architect";

export interface ProfileFormState {
  ok: boolean;
  message: string;
}

const TYPES: ReadonlySet<string> = new Set<ProjectType>(["tech", "marketing"]);
const PROVIDERS: ReadonlySet<string> = new Set<Provider>([
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "groq",
  "ollama",
]);

export async function saveProfileAction(
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const displayName = String(formData.get("displayName") ?? "").trim();
  const language = String(formData.get("language") ?? "fr") === "en" ? "en" : "fr";
  const tone = String(formData.get("tone") ?? "").trim();
  const rawType = String(formData.get("defaultProjectType") ?? "tech");
  const rawProvider = String(formData.get("preferredProvider") ?? "");
  const rawBudget = String(formData.get("defaultBudgetUsd") ?? "").trim();

  try {
    const userId = await getCurrentUserId();
    await upsertProfile(userId, {
      displayName: displayName || null,
      language,
      tone: tone || undefined,
      defaultProjectType: (TYPES.has(rawType) ? rawType : "tech") as ProjectType,
      preferredProvider: PROVIDERS.has(rawProvider)
        ? (rawProvider as Provider)
        : null,
      defaultBudgetUsd: rawBudget === "" ? null : Number(rawBudget),
    });
    revalidatePath("/profile");
    return { ok: true, message: "Profil enregistré." };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Erreur d'enregistrement.",
    };
  }
}
