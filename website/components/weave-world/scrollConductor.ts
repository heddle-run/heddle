/* Converts native document scroll into a continuous "which section, how far
   through it" number — the single source of truth the 3D world reads every
   frame. Section anchors are the page's own <section> elements, so the world
   always matches whatever order app/page.tsx actually renders; nothing here
   hard-codes section heights or copy.

   `target` is exact and reproducible (same scrollY always yields the same
   value, forward, backward, or after reload) — smoothing lives only in
   `smooth`, and only when motion isn't reduced, per the skill's rule that
   render-only easing must never leak into the state used for anything else. */

const SECTION_SELECTOR = "#main > section";

export function measureSectionTops(): number[] {
  if (typeof document === "undefined") return [];
  const sections = Array.from(
    document.querySelectorAll<HTMLElement>(SECTION_SELECTOR),
  );
  const scrollY = window.scrollY;
  return sections.map((el) => el.getBoundingClientRect().top + scrollY);
}

export function progressFromScroll(scrollY: number, tops: number[]): number {
  if (tops.length === 0) return 0;
  const docHeight = document.documentElement.scrollHeight - window.innerHeight;
  const lastBottom = docHeight > tops[tops.length - 1] ? docHeight : tops[tops.length - 1] + 1;
  const boundaries = [...tops, lastBottom];

  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (scrollY < end || i === boundaries.length - 2) {
      const span = Math.max(end - start, 1);
      const frac = Math.min(Math.max((scrollY - start) / span, 0), 1);
      return i + frac;
    }
  }
  return boundaries.length - 2;
}

export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

export class ScrollConductor {
  private tops: number[] = [];
  target = 0;
  smooth = 0;
  private reduceMotion: boolean;

  constructor(reduceMotion: boolean) {
    this.reduceMotion = reduceMotion;
  }

  remeasure() {
    this.tops = measureSectionTops();
  }

  update(dt: number) {
    /* Keyed to the viewport's centre, not its top edge: the chapter whose
       copy the reader is looking at is the one the world should be in.
       With the top edge as the key, a dark-band chapter started fading
       back to paper while its own copy was still centred on screen —
       caught by eye on the Position chapter. */
    this.target = progressFromScroll(
      window.scrollY + window.innerHeight * 0.5,
      this.tops,
    );
    this.smooth = this.reduceMotion
      ? this.target
      : damp(this.smooth, this.target, 5.2, dt);
  }
}
