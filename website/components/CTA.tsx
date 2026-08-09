import { Button, Icon, InstallCommand } from "@/ds-heddle";
import { installTabs, PLAYGROUND_URL } from "@/lib/constants";

/* The close — the loom's "final weave" chapter. The section paints nothing:
   the world's canvas goes navy for this whole chapter (chapters.ts keyframe
   8), the shed opens wide, and the Chapter wrapper's full-width band scrim
   settles the copy. An earlier pass tried a small radial scrim here instead
   and it read as a floating oval in a real browser — the fix was making the
   world own the surface, not patching the DOM. */
export default function CTA() {
  return (
    <div style={{ position: "relative" }}>
      <div
        className="hds-container"
        style={{
          position: "relative",
          zIndex: 1,
          paddingTop: 88,
          paddingBottom: 88,
          textAlign: "center",
        }}
      >
        <h2
          style={{
            fontFamily: "var(--font-serif)",
            fontStyle: "italic",
            fontSize: "var(--fs-display-3)",
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
          One program. One file. Ten minutes.
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
        {/* hds-install so the long library-bundle command wraps at narrow
            widths instead of overflowing the viewport, same as the hero. */}
        <div
          className="hds-install"
          style={{ marginTop: 24, maxWidth: 640, marginInline: "auto" }}
        >
          <InstallCommand
            command={installTabs[0].commands[0].cmd}
            style={{ background: "var(--surface-code-alt)" }}
          />
        </div>
      </div>
    </div>
  );
}
