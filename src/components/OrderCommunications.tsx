'use client';

/**
 * Order communications list — shared presentational component for the order-detail
 * surfaces (admin order detail, shop order history). Renders each communication as a
 * type badge + subject + timestamp row with an expandable body; `showRecipient` adds
 * the admin-only recipient line (the customer view shows no internal detail).
 */

import { useState } from 'react';
// Direct module import (not the contracts barrel) — pure module, PR #41.
import type { CommunicationDocument } from '@/temporal/contracts/elasticsearch';

const TYPE_LABELS: Record<string, string> = {
  'order-confirmation': 'Confirmation',
  'order-status': 'Status update',
  shipped: 'Shipped',
  delivered: 'Delivered',
  'feedback-thanks': 'Feedback thanks',
};

export default function OrderCommunications({
  communications,
  showRecipient = false,
  emptyText = 'No communications recorded for this order.',
}: {
  communications: CommunicationDocument[];
  showRecipient?: boolean;
  emptyText?: string;
}) {
  if (communications.length === 0) {
    return <p className="text-zinc-500 text-sm">{emptyText}</p>;
  }
  return (
    <div className="space-y-2">
      {communications.map((comm) => (
        <CommunicationRow key={comm.id} comm={comm} showRecipient={showRecipient} />
      ))}
    </div>
  );
}

function CommunicationRow({
  comm,
  showRecipient,
}: {
  comm: CommunicationDocument;
  showRecipient: boolean;
}) {
  const [open, setOpen] = useState(false);
  const sent = new Date(comm.sentAt);
  const sentLabel = Number.isNaN(sent.getTime()) ? comm.sentAt : sent.toLocaleString();

  return (
    <div className="p-3 bg-zinc-50 dark:bg-zinc-750 rounded-lg border border-zinc-100 dark:border-zinc-700">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left"
        title="Click to expand / collapse the message body"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 whitespace-nowrap">
            {TYPE_LABELS[comm.commType ?? ''] ?? comm.channel}
          </span>
          <span className="flex-1 min-w-0 truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
            {comm.subject}
          </span>
          <span className="text-xs text-zinc-500 whitespace-nowrap">{sentLabel}</span>
          <span className="text-xs text-zinc-400">{open ? '▾' : '▸'}</span>
        </div>
        {showRecipient && (
          <div className="mt-1 text-xs text-zinc-500">
            To: <span className="font-mono">{comm.recipient}</span>
          </div>
        )}
      </button>
      {open && (
        <div className="mt-2 pt-2 border-t border-zinc-200 dark:border-zinc-700 text-sm text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">
          {comm.body || <span className="italic text-zinc-500">No message body recorded.</span>}
        </div>
      )}
    </div>
  );
}
