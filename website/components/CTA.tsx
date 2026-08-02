import { Button, Icon, InstallCommand } from "@/ds-heddle";
import { installTabs, PLAYGROUND_URL } from "@/lib/constants";

/* The close, on the always-dark band with the warp-thread texture. Same
   surface reasoning as Position: --surface-code stays navy-dark in both
   themes where --surface-inverse flips. */
export default function CTA() {
  return (
    <section
      style={{
        background: "var(--surface-code)",
        backgroundImage: "var(--texture-warp)",
        backgroundBlendMode: "overlay",
        borderTop: "1px solid var(--border-hairline)",
      }}
    >
      <div
        className="hds-container"
        style={{ paddingTop: 88, paddingBottom: 88, textAlign: "center" }}
      >
        <h2
          style={{
            fontSize: "var(--fs-display-3)",
            fontWeight: "var(--fw-light)",
            letterSpacing: "var(--ls-display)",
            color: "var(--code-fg)",
            margin: 0,
          }}
        >
          Thread the loom.
        </h2>
        <p
          style={{
            color: "var(--slate-300)",
            fontSize: 17,
            margin: "14px 0 0",
          }}
        >
          One binary. One document. No lockfile entry.
        </p>
        <div
          style={{
            display: "flex",
            gap: 12,
            justifyContent: "center",
            marginTop: 26,
            flexWrap: "wrap",
          }}
        >
          <Button
            as="a"
            href="/docs/getting-started"
            size="lg"
            variant="accent"
            iconRight={<Icon name="arrowRight" size={16} />}
          >
            Get started
          </Button>
          <Button
            as="a"
            href={PLAYGROUND_URL}
            size="lg"
            variant="ghost"
            style={{
              color: "var(--cloud-100)",
              border: "1px solid var(--border-inverse)",
            }}
          >
            Open the playground
          </Button>
        </div>
        <div
          style={{ marginTop: 24, display: "flex", justifyContent: "center" }}
        >
          <InstallCommand
            command={installTabs[0].commands[0].cmd}
            style={{ background: "var(--surface-code-alt)" }}
          />
        </div>
      </div>
    </section>
  );
}
