"use server";

import { revalidatePath } from "next/cache";

import { createNorme, deleteNorme } from "@/lib/normes";
import { getCurrentUserId } from "@/lib/users";

export interface NormeFormState {
  ok: boolean;
  message: string;
}

export async function createNormeAction(
  _prev: NormeFormState,
  formData: FormData,
): Promise<NormeFormState> {
  const name = String(formData.get("name") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const promptContent = String(formData.get("promptContent") ?? "").trim();

  if (!name) return { ok: false, message: "Nom de la norme requis." };
  if (!promptContent) return { ok: false, message: "Contenu de la norme requis." };

  try {
    const userId = await getCurrentUserId();
    // Cette page crée des normes globales (réutilisables inter-projets) ;
    // l'association à une phase se fait depuis la page projet.
    await createNorme(userId, {
      name,
      category: category || null,
      promptContent,
      scope: "global",
    });
    revalidatePath("/normes");
    return { ok: true, message: `Norme « ${name} » créée.` };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Erreur de création.",
    };
  }
}

export async function deleteNormeAction(formData: FormData): Promise<void> {
  const id = String(formData.get("normeId") ?? "");
  if (!id) return;
  const userId = await getCurrentUserId();
  await deleteNorme(userId, id);
  revalidatePath("/normes");
}
