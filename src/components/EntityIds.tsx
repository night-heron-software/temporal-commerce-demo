'use client';

/**
 * EntityIds — copyable ID chips for admin & devtools views.
 *
 * F3 (validation run -006, operator verbatim): "do not abbreviate uuids in the admin
 * interface and give them all copy buttons." Chips therefore render the FULL value in a
 * monospace face (wrapping via break-all rather than truncating) with click-to-copy.
 * `IdChip` is the generic building block (remediation R2 / backlog #2); `CopyIdButton`
 * is the icon-only variant for ids already rendered elsewhere (e.g. inside a link).
 * The default export renders the common corr:/order: pair.
 */

import { useState } from 'react';

function useCopy(value: string) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable (http, permissions) — leave the control inert
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') copy(e);
  };
  return { copied, copy, onKeyDown };
}

/**
 * Generic copyable id chip: full monospace value (break-all, never truncated), label
 * prefix, click-to-copy with a "✓" flash. Style via className; the default is the
 * neutral zinc chip used across admin tables.
 */
export function IdChip({
  label,
  value,
  className = 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700',
}: {
  label?: string;
  value: string;
  className?: string;
}) {
  const { copied, copy, onKeyDown } = useCopy(value);

  // Rendered as a span[role=button], not a <button>: chips live inside interactive
  // containers (the carts page row header is itself a <button>), where a nested
  // button is invalid HTML and a hydration error.
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={copy}
      onKeyDown={onKeyDown}
      title={`${label ? `${label} ` : ''}${value}\nClick to copy`}
      className={`inline-flex items-baseline gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] leading-4 cursor-pointer select-none text-left ${className}`}
    >
      {label && <span className="opacity-60 shrink-0">{label}</span>}
      <span className="break-all">
        {value}
        {copied && <span className="ml-1 opacity-80">✓</span>}
      </span>
    </span>
  );
}

/**
 * Icon-only copy affordance for an id that is already rendered (e.g. as a link text).
 * Keeps navigation and copying as separate controls instead of hiding one behind the other.
 */
export function CopyIdButton({ value, className = '' }: { value: string; className?: string }) {
  const { copied, copy, onKeyDown } = useCopy(value);
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={copy}
      onKeyDown={onKeyDown}
      title={`${value}\nClick to copy`}
      className={`inline-flex items-center rounded px-1 text-[11px] leading-4 cursor-pointer select-none text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 ${className}`}
    >
      {copied ? '✓' : '⧉'}
    </span>
  );
}

/**
 * Renders `corr:` and `order:` chips for whichever IDs are present.
 * `correlationId` is the journey UUID; pass `orderId` when the entity has one.
 */
export default function EntityIds({
  correlationId,
  orderId,
  className = '',
}: {
  correlationId?: string | null;
  orderId?: string | null;
  className?: string;
}) {
  if (!correlationId && !orderId) return null;
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}>
      {correlationId && (
        <IdChip
          label="corr:"
          value={correlationId}
          className="bg-violet-50 text-violet-700 hover:bg-violet-100 dark:bg-violet-950 dark:text-violet-300 dark:hover:bg-violet-900"
        />
      )}
      {orderId && (
        <IdChip
          label="order:"
          value={orderId}
          className="bg-sky-50 text-sky-700 hover:bg-sky-100 dark:bg-sky-950 dark:text-sky-300 dark:hover:bg-sky-900"
        />
      )}
    </span>
  );
}
