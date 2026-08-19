/**
 * Who is signed in, server-side.
 *
 * The shopper session is a `shopperId` cookie; turning it into a profile takes two
 * partition-key reads (id → email, then email → profile), because `shoppers` is keyed by
 * email while the cookie carries the id.
 *
 * Extracted so the CART can ask the question too. Cart↔shopper linking used to live only in
 * the login route, which links whatever cart exists AT SIGN-IN — so a cart created afterwards
 * (the normal case once a prior cart completes) stayed a guest cart for life, and the
 * shopper's cart was unrecoverable at their next sign-in because that recovery query matches
 * on the cart doc's `email` (backlog #11).
 *
 * `GET /api/auth/shopper/me` keeps its own copy of this lookup deliberately: it also DELETES a
 * cookie whose shopper no longer exists, which is a mutation this read must not perform — a
 * getter that clears sessions is a trap. Keep the two in step if the schema moves.
 */
import { cookies } from 'next/headers';
import { executeCql } from '@/lib/cassandra-client';

const SHOPPER_COOKIE = 'shopperId';

export interface SignedInShopper {
  id: string;
  email: string;
}

/** The signed-in shopper, or null when the visitor is a genuine guest. */
export async function getSignedInShopper(): Promise<SignedInShopper | null> {
  const cookieStore = await cookies();
  const shopperId = cookieStore.get(SHOPPER_COOKIE)?.value;
  if (!shopperId) return null;

  const idRows = await executeCql<{ email: string }>(
    `SELECT email FROM shoppers_by_id WHERE id = ?`,
    [shopperId],
  );
  if (idRows.length === 0) return null;

  return { id: shopperId, email: idRows[0].email };
}
