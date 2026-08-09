"use client";

/* The persistent 3D loom. One renderer, one scene, mounted once for the
   whole page and driven purely by native scroll — scrollConductor.ts turns
   scrollY into a fractional chapter number, chapters.ts says what the loom
   is doing at that number, threadField.ts owns the geometry: a three-thread
   ply on a shared spine, plus the weft tube. Never mounted under
   prefers-reduced-motion or without WebGL: the SVG WeaveTexture in
   WeaveGround.tsx is the ground in those cases, so the page never depends
   on this canvas for content, only atmosphere.

   The camera is a fixed orthographic cover box around the braid's design
   space (the reference frame threadField.ts positions in); scroll drives
   the braid's twist, shed and weft through uniforms rather than moving a
   camera. The previous perspective build's dolly is what smeared geometry
   across the near plane — a whole class of bug this removes.

   Verified by eye in a real browser, not by scripted screenshots. The
   canvas repaints the page ground per theme (the first build hardcoded
   paper and lit the dark theme white). */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useReducedMotion } from "motion/react";
import { ScrollConductor } from "./scrollConductor";
import { sampleWorld, palette } from "./chapters";
import { createPly, createWeftRibbon } from "./threadField";

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl2") || canvas.getContext("webgl"))
    );
  } catch {
    return false;
  }
}

export default function WeaveWorld() {
  const mountRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce) return;
    if (!supportsWebGL()) return;
    const mount = mountRef.current;
    if (!mount) return;

    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    mount.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);

    /* The ground: a fullscreen quad pinned to the far plane, drawing the
       ivory vertical gradient and crossing to the band colour on the dark
       chapters — a WebGL clear colour can only be flat. */
    const bgGeometry = new THREE.PlaneGeometry(2, 2);
    const bgMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.9999, 1.0);
        }`,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform vec3 uTop;
        uniform vec3 uBottom;
        uniform vec3 uBand;
        uniform float uBandMix;
        void main() {
          vec3 c = mix(uBottom, uTop, vUv.y);
          gl_FragColor = vec4(mix(c, uBand, uBandMix), 1.0);
        }`,
      uniforms: {
        uTop: { value: new THREE.Color("#fefdfa") },
        uBottom: { value: new THREE.Color("#f7f4ed") },
        uBand: { value: new THREE.Color("#081b2c") },
        uBandMix: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const bgQuad = new THREE.Mesh(bgGeometry, bgMaterial);
    bgQuad.frustumCulled = false;
    bgQuad.renderOrder = -1;
    scene.add(bgQuad);

    const ply = createPly();
    scene.add(ply.group);
    const weft = createWeftRibbon();
    scene.add(weft.mesh);

    /* Theme: the canvas paints the page ground, so it must follow the
       html.dark toggle live, not just at mount. */
    let dark = document.documentElement.classList.contains("dark");
    const themeObserver = new MutationObserver(() => {
      dark = document.documentElement.classList.contains("dark");
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const conductor = new ScrollConductor(false);

    function setSize() {
      const width = mount!.clientWidth || window.innerWidth;
      const height = mount!.clientHeight || window.innerHeight;
      renderer.setSize(width, height, false);
      /* Cover box over the design space threadField.ts positions in. The
         braid's sweep centres near x = 0.5, so a box centred left of it
         (cx = 0) puts the braid on the right side of the frame, clear of
         the centred copy; the weft enters across the emptier left. Tall
         viewports keep the design height and widen; wide viewports keep
         the width and grow taller. */
      const aspect = width / Math.max(height, 1);
      const cx = 0;
      const cy = 0.02;
      const designHalfH = 0.72;
      const designHalfW = 0.95;
      const halfH = Math.max(designHalfH, designHalfW / aspect);
      camera.top = cy + halfH;
      camera.bottom = cy - halfH;
      camera.left = cx - halfH * aspect;
      camera.right = cx + halfH * aspect;
      camera.updateProjectionMatrix();
    }
    setSize();

    function remeasure() {
      conductor.remeasure();
    }
    remeasure();
    const remeasureTimeout = window.setTimeout(remeasure, 400);

    window.addEventListener("resize", setSize);
    window.addEventListener("resize", remeasure);
    window.addEventListener("load", remeasure);

    let raf = 0;
    let last = performance.now();
    let start = last;
    let disposed = false;

    function frame(now: number) {
      if (disposed) return;
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      const time = (now - start) / 1000;

      conductor.update(dt);
      const world = sampleWorld(conductor.smooth);
      const colors = palette(dark);

      (bgMaterial.uniforms.uTop.value as THREE.Color).set(colors.pageTop);
      (bgMaterial.uniforms.uBottom.value as THREE.Color).set(colors.pageBottom);
      (bgMaterial.uniforms.uBand.value as THREE.Color).set(colors.band);
      bgMaterial.uniforms.uBandMix.value = world.bandMix;

      /* On the light theme's paper the threads deepen for contrast; on the
         navy bands and the whole dark theme they glow instead. */
      const paper = dark ? 0 : 1 - world.bandMix;
      const glow = dark ? 0.35 + world.glow * 0.65 : world.glow;
      ply.update(time, 1 + world.shed * 1.6, glow, paper, world.drift);
      weft.update(time, world.weft, Math.max(world.bandMix, dark ? 1 : 0), paper);

      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    function onVisibility() {
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(remeasureTimeout);
      window.removeEventListener("resize", setSize);
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("load", remeasure);
      document.removeEventListener("visibilitychange", onVisibility);
      themeObserver.disconnect();
      bgGeometry.dispose();
      bgMaterial.dispose();
      ply.dispose();
      weft.dispose();
      renderer.dispose();
      mount.removeChild(canvas);
    };
  }, [reduce]);

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: -1,
        pointerEvents: "none",
      }}
    />
  );
}
