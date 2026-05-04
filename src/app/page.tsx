import { redirect } from 'next/navigation';

/**
 * Root page — redirects to /shop
 */
export default function HomePage() {
  redirect('/shop');
}
