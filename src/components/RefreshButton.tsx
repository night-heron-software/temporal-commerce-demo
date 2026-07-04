'use client';

import { useState, useCallback } from 'react';

interface RefreshButtonProps {
  onRefresh: () => Promise<void>;
  label?: string;
  variant?: 'admin' | 'dev';
}

export function RefreshButton({
  onRefresh,
  label = 'Refresh',
  variant = 'admin',
}: RefreshButtonProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleClick = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh]);

  const baseClasses =
    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50';

  const variantClasses =
    variant === 'dev'
      ? 'bg-gray-700 hover:bg-gray-600 text-gray-200 border border-gray-600'
      : 'bg-white dark:bg-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-600 text-[var(--heron-slate)] dark:text-zinc-200 border border-[var(--heron-cream-dark)] dark:border-zinc-600 shadow-sm';

  return (
    <button
      onClick={handleClick}
      disabled={isRefreshing}
      className={`${baseClasses} ${variantClasses}`}
      title={label}
    >
      <span
        className={`inline-block text-base ${isRefreshing ? 'animate-spin' : ''}`}
        aria-hidden="true"
      >
        ↻
      </span>
      {label}
    </button>
  );
}
