import { Suspense } from "react";
import { PhoneCall } from "./phone-call";

export const metadata = { title: "The guard is calling · Graveyard Shift" };

export default function Page() {
  return <Suspense fallback={<main className="wrap"><div className="sys">Connecting to the guard…</div></main>}><PhoneCall /></Suspense>;
}
