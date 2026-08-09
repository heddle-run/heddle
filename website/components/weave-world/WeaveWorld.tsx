"use client";

/* The persistent 3D loom. One renderer, one scene, mounted once for the
   whole page and driven purely by native scroll — scrollConductor.ts turns
   scrollY into a fractional chapter number, chapters.ts says what the loom
   is doing at that number, threadField.ts owns the geometry. Never mounted
   under prefers-reduced-motion or without WebGL: the SVG WeaveTexture in
   WeaveGround.tsx is the ground in those cases, so the page never depends
   on this canvas for content, only atmosphere.

   Verified by eye in a real browser, not by scripted screenshots — the
   camera dolly is clamped so it can never cross the nearest thread band
   (crossing the near plane smears geometry across the screen; caught live
   in phase one), and the canvas repaints the page ground per theme (phase
   one hardcoded paper and lit the dark theme white). */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useReducedMotion } from "motion/react";
import { ScrollConductor } from "./scrollConductor";
import { sampleWorld, palette } from "./chapters";
import { createWarpField, createWeftLine } from "./threadField";

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
    renderer.localClippingEnabled = true;

    const scene = new THREE.Scene();
    const fog = new THREE.FogExp2(0xf6f9fc, 0.02);
    scene.fog = fog;

    const camera = new THREE.PerspectiveCamera(
      44,
      mount.clientWidth / Math.max(mount.clientHeight, 1),
      0.1,
      120,
    );
    camera.position.set(0, 0, 8);

    const key = new THREE.DirectionalLight(0xffffff, 1);
    key.position.set(5, 7, 6);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdbe6ff, 0.3);
    fill.position.set(-6, -3, 4);
    scene.add(fill);
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambient);

    const warp = createWarpField();
    scene.add(warp.group);
    const weft = createWeftLine();
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
      camera.aspect = width / Math.max(height, 1);
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

    const pageColor = new THREE.Color();
    const bandColor = new THREE.Color();
    const bg = new THREE.Color();

    function frame(now: number) {
      if (disposed) return;
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      const time = (now - start) / 1000;

      conductor.update(dt);
      const isMobile = window.innerWidth < 760;
      const world = sampleWorld(conductor.smooth);
      const colors = palette(dark);

      pageColor.set(colors.page);
      bandColor.set(colors.band);
      bg.copy(pageColor).lerp(bandColor, world.bandMix);
      renderer.setClearColor(bg, 1);
      fog.color.copy(bg);
      fog.density = world.fog;

      key.intensity = world.key;
      ambient.intensity = world.ambient;

      /* In the dark theme the threads carry the image on a near-black
         ground, so their glow floor rises. */
      const emissive = dark
        ? 0.35 + world.emissive * 0.65
        : world.emissive;
      warp.update(time, world.shed, emissive);

      /* The weft reads as ink on paper and as light on the dark bands. */
      const inkOnBand = world.bandMix > 0.5 || dark;
      weft.update(
        world.weft,
        inkOnBand ? 0x90e0ff : 0x081b2c,
        inkOnBand ? 0.9 : 0.1,
      );

      camera.fov = isMobile ? world.fovMobile : world.fov;
      /* cameraZ spans 0..31 over the page; scaled and clamped so the camera
         stays well in front of the nearest band at z=-2 — it ends at z=+3.7. */
      camera.position.z = Math.max(8 - world.cameraZ * 0.14, 3.5);
      camera.position.y = Math.sin(conductor.smooth * 0.7) * 0.4;
      camera.lookAt(0, 0, camera.position.z - 10);
      camera.updateProjectionMatrix();

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
      warp.dispose();
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
