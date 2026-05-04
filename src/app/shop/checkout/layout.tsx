import { CheckoutProgress } from '@/components/CheckoutProgress';

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--heron-cream-light)] dark:bg-[var(--heron-forest-dark)]">
      <div className="pt-6 px-8">
        <CheckoutProgress />
      </div>
      {children}
    </div>
  );
}
