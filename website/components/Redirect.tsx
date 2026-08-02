"use client";

import { useEffect } from "react";

/**
 * Forwards a page that has moved, and says so for the moment before it
 * happens — or for as long as it takes, on a reader with no scripting.
 *
 * `replace` rather than `assign`: the page being left is not somewhere the
 * back button should return to, because it would forward again.
 */
export default function Redirect({
  to,
  label,
}: {
  to: string;
  label: string;
}) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);

  return (
    <main
      style={{
        display: "grid",
        placeItems: "center",
        minHeight: "60dvh",
        padding: "var(--section-y-sm) var(--space-6)",
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: "var(--fs-body)",
          lineHeight: "var(--lh-body)",
          color: "var(--text-muted)",
          textAlign: "center",
        }}
      >
        This page has moved.{" "}
        <a href={to}>Continue to {label}</a>.
      </p>
    </main>
  );
}
