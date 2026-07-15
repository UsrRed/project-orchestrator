"use client";

/**
 * <select> qui soumet automatiquement son formulaire parent au changement.
 * Permet l'édition inline (statut, mode, priorité) via Server Actions sans
 * état client explicite.
 */
export function AutoSubmitSelect({
  name,
  defaultValue,
  options,
  title,
}: {
  name: string;
  defaultValue: string;
  options: Array<{ value: string; label: string }>;
  title?: string;
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue}
      title={title}
      onChange={(e) => e.currentTarget.form?.requestSubmit()}
      className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-emerald-500"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
