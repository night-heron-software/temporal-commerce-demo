'use client';

import { useState, useRef, useEffect } from 'react';
import { useShopper } from '@/context/ShopperContext';

export function AccountDropdown() {
  const { shopper, loading, signIn, signOut } = useShopper();
  const [isOpen, setIsOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus input when dropdown opens
  useEffect(() => {
    if (isOpen && !shopper && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen, shopper]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setError(null);
    const result = await signIn(email.trim());
    if (!result.ok) {
      setError(result.error || 'Sign in failed');
    } else {
      setEmail('');
      setIsOpen(false);
    }
    setSubmitting(false);
  };

  const handleSignOut = async () => {
    await signOut();
    setIsOpen(false);
  };

  if (loading) {
    return (
      <div className="w-8 h-8 rounded-full bg-zinc-200 dark:bg-zinc-700 animate-pulse" />
    );
  }

  return (
    <div ref={dropdownRef} className="relative">
      <button
        id="btn-account-dropdown"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
      >
        {shopper ? (
          <>
            <span className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs flex items-center justify-center font-medium">
              {shopper.name.charAt(0).toUpperCase()}
            </span>
            <span className="hidden sm:inline max-w-[120px] truncate">
              {shopper.name}
            </span>
          </>
        ) : (
          <>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
            </svg>
            <span className="hidden sm:inline">Sign In</span>
          </>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-white dark:bg-zinc-800 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden z-50">
          {shopper ? (
            /* ── Signed In ── */
            <div className="p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-indigo-600 text-white flex items-center justify-center font-semibold text-lg">
                  {shopper.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{shopper.name}</div>
                  <div className="text-xs text-zinc-500 truncate">{shopper.email}</div>
                </div>
              </div>
              <button
                id="btn-sign-out"
                onClick={handleSignOut}
                className="w-full px-3 py-2 text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 rounded-lg transition-colors text-left"
              >
                Sign Out
              </button>
            </div>
          ) : (
            /* ── Not Signed In ── */
            <form onSubmit={handleSignIn} className="p-4">
              <div className="text-sm font-medium mb-3">Sign in with email</div>
              {error && (
                <div className="text-xs text-red-500 mb-2">{error}</div>
              )}
              <input
                ref={inputRef}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                className="w-full px-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg focus:border-indigo-500 focus:outline-none mb-3"
              />
              <button
                type="submit"
                disabled={submitting || !email.trim()}
                className="w-full px-3 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors font-medium"
              >
                {submitting ? 'Signing in…' : 'Continue'}
              </button>
              <p className="text-xs text-zinc-400 mt-2 text-center">
                No password needed — just enter your email
              </p>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
