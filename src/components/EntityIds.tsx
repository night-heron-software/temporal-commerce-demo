'use client';

/**
 * EntityIds — compact, copyable correlation/order ID chips for admin & devtools views.
 *
 * Every entity in the system is correlated by CorrelationId (= cartId, ADR-0011) and,
 * once an order exists, by orderId. These chips make both visible wherever an entity
 * or projection is rendered: truncated for scanning, click-to-copy for the full value.
 */

import { useState } from 'react';

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function IdChip({ label, value, className }: { label: string; value: string; className: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable (http, permissions) — leave the chip inert
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={`${label}: ${value}\nClick to copy`}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] leading-4 cursor-pointer select-none ${className}`}
    >
      <span className="opacity-60">{label}</span>
      <span>{copied ? 'copied ✓' : short(value)}</span>
    </button>
  );
}

/**
 * Renders `corr:` and `order:` chips for whichever IDs are present.
 * `correlationId` is the cart ID; pass `orderId` when the entity has one.
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
