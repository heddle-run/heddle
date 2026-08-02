"use client";

import { usePathname } from "next/navigation";
import { Backdrop } from "@/ds";

/* The FormFlow backdrop belongs only to the pages still built on that system.
   The landing (and the 404, which shares its components) runs on the Heddle
   system, whose ground is flat paper — rendering the swirls under an opaque
   page would be wasted work, and any transparent seam would leak them. */
const FORMFLOW_ROUTES = ["/docs", "/playground", "/compare"];

export default function RouteBackdrop() {
  const pathname = usePathname() ?? "/";
  const formflow = FORMFLOW_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
  return formflow ? <Backdrop /> : null;
}
