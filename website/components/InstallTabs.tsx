"use client";

import { useState } from "react";
import CopyCommand from "./CopyCommand";
import Tabs from "./Tabs";
import { installTabs } from "@/lib/constants";

/**
 * The first command, for whoever is reading.
 *
 * Both tabs hold *run* commands rather than installs, which is the whole claim —
 * so the tab is not "how do you want to install it" but "which of you is asking".
 */
export default function InstallTabs() {
  const [active, setActive] = useState(installTabs[0].id);
  const tab = installTabs.find((t) => t.id === active) ?? installTabs[0];

  return (
    <div
      style={{
        margin: "var(--space-12) auto 0",
        maxWidth: 560,
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
      }}
    >
      <Tabs
        label="Who is installing"
        align="center"
        tabs={installTabs.map(({ id, label }) => ({ id, label }))}
        active={active}
        onSelect={setActive}
      />

      {/* Both panels occupy one grid cell, so the taller one sets the height and
          switching tabs does not move the page under the pointer. The hidden one
          is `inert`, or its copy button would still be reachable by tab key. */}
      <div style={{ display: "grid" }}>
        {installTabs.map((panel) => {
          const shown = panel.id === tab.id;
          return (
            <div
              key={panel.id}
              role="tabpanel"
              aria-hidden={!shown}
              inert={shown ? undefined : true}
              style={{
                gridArea: "1 / 1",
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-3)",
                visibility: shown ? "visible" : "hidden",
              }}
            >
              {panel.commands.map((c) => (
                <CopyCommand key={c.label} label={c.label} command={c.cmd} />
              ))}
              <p
                style={{
                  margin: 0,
                  textAlign: "center",
                  fontSize: "var(--fs-xs)",
                  color: "var(--text-muted)",
                }}
              >
                {panel.note}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
