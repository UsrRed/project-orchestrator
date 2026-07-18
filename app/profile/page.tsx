import { getProfile } from "@/lib/profile";
import { getCurrentUserId } from "@/lib/users";
import { ProfileForm } from "./profile-form";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const userId = await getCurrentUserId();
  const profile = await getProfile(userId);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-widest text-emerald-400">
          Préférences
        </span>
        <h1 className="text-4xl font-bold tracking-tight">Profil</h1>
        <p className="text-sm text-neutral-400">
          Ces préférences personnalisent l&apos;IA (langue, ton), fixent le type
          de projet et le plafond de tokens par défaut d&apos;un projet.
        </p>
      </header>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
        <ProfileForm profile={profile} />
      </section>
    </main>
  );
}
