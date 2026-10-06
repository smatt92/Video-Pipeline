import { redirect } from 'next/navigation';

/** The control room opens on the decisions waiting for you. */
export default function BureauIndex() {
  redirect('/bureau/approvals');
}
