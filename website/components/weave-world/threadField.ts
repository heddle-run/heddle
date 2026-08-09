/* The loom's geometry, second pass. The first pass drew the threads as
   LineSegments2 fat-lines — constant pixel width, no shading — and in a
   real browser they read as a plot grid, not fibre. These are actual tubes:
   each warp thread is a TubeGeometry around a CatmullRom path with a slight
   catenary bow and two sine harmonics of wobble, lit by the scene's key
   light with a per-thread MeshStandardMaterial, so a thread has a lit side,
   a shadow side and a highlight the way a strand of silk does.

   The shed — the loom action the brand is named for — is done the way a
   real heddle does it: alternate threads pull apart in *depth* (z), not
   sideways, opening a gap the weft passes through. The weft is a thicker
   horizontal tube revealed left-to-right by a clipping plane, which needs
   renderer.localClippingEnabled = true (WeaveWorld sets it). */

import * as THREE from "three";
import { THREAD_HUES } from "./chapters";

export const X_SPAN = 10;
export const Y_SPAN = 13;

const DEPTH_BANDS = [
  { z: -2, count: 16, radius: 0.055, sway: 1 },
  { z: -9, count: 18, radius: 0.04, sway: 0.7 },
  { z: -18, count: 20, radius: 0.028, sway: 0.45 },
];

type WarpThread = {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  baseX: number;
  baseZ: number;
  parity: number;
  phase: number;
  sway: number;
  color: THREE.Color;
};

function threadPath(bow: number, wobble: number, seed: number): THREE.CatmullRomCurve3 {
  const points: THREE.Vector3[] = [];
  const STEPS = 16;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const y = Y_SPAN - t * Y_SPAN * 2;
    const x =
      Math.sin(t * Math.PI) * bow +
      Math.sin(t * Math.PI * 3 + seed) * wobble +
      Math.sin(t * Math.PI * 7 + seed * 2.7) * wobble * 0.4;
    const z = Math.cos(t * Math.PI * 2 + seed) * wobble * 0.6;
    points.push(new THREE.Vector3(x, y, z));
  }
  return new THREE.CatmullRomCurve3(points);
}

export type WarpField = {
  group: THREE.Group;
  update(time: number, shed: number, emissive: number): void;
  dispose(): void;
};

export function createWarpField(): WarpField {
  const group = new THREE.Group();
  const threads: WarpThread[] = [];
  let rand = 1;
  const random = () => {
    /* Deterministic LCG so the loom is identical on every load. */
    rand = (rand * 48271) % 2147483647;
    return rand / 2147483647;
  };

  DEPTH_BANDS.forEach((band, bandIndex) => {
    for (let i = 0; i < band.count; i++) {
      const t = i / (band.count - 1);
      const baseX = -X_SPAN + t * X_SPAN * 2 + (random() - 0.5) * 0.35;
      const hue = THREAD_HUES[(i + bandIndex * 2) % THREAD_HUES.length];
      const color = new THREE.Color(hue);
      color.offsetHSL(0, (random() - 0.5) * 0.08, (random() - 0.5) * 0.09);

      const bow = (random() - 0.5) * 0.5;
      const wobble = 0.06 + random() * 0.1;
      const curve = threadPath(bow, wobble, random() * Math.PI * 2);
      const geometry = new THREE.TubeGeometry(
        curve,
        40,
        band.radius * (0.85 + random() * 0.3),
        6,
        false,
      );
      const material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.55,
        metalness: 0.1,
        emissive: color,
        emissiveIntensity: 0.1,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(baseX, 0, band.z);
      group.add(mesh);

      threads.push({
        mesh,
        material,
        baseX,
        baseZ: band.z,
        parity: i % 2 === 0 ? 1 : -1,
        phase: random() * Math.PI * 2,
        sway: band.sway,
        color,
      });
    }
  });

  return {
    group,
    update(time: number, shed: number, emissive: number) {
      for (const thread of threads) {
        /* The shed: alternate threads separate in depth, the way a heddle
           actually lifts every other warp end. A little x drift keeps the
           opening from reading as two flat walls. */
        thread.mesh.position.z =
          thread.baseZ + thread.parity * shed * 1.6;
        thread.mesh.position.x =
          thread.baseX +
          thread.parity * shed * 0.18 +
          Math.sin(time * 0.4 + thread.phase) * 0.09 * thread.sway;
        thread.mesh.rotation.z =
          Math.sin(time * 0.3 + thread.phase * 1.3) * 0.012 * thread.sway;
        thread.material.emissiveIntensity = 0.08 + emissive * 0.55;
      }
    },
    dispose() {
      for (const thread of threads) {
        thread.mesh.geometry.dispose();
        thread.material.dispose();
      }
    },
  };
}

export type WeftLine = {
  mesh: THREE.Mesh;
  update(reveal: number, color: THREE.ColorRepresentation, glow: number): void;
  dispose(): void;
};

export function createWeftLine(): WeftLine {
  const points: THREE.Vector3[] = [];
  const STEPS = 40;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const x = -X_SPAN + t * X_SPAN * 2;
    /* A weft thread sags between passes and rides over/under the shed. */
    const y = Math.sin(t * Math.PI) * -0.35 + Math.sin(t * Math.PI * 5) * 0.16;
    const z = -5.5 + Math.sin(t * Math.PI * 2.5) * 0.4;
    points.push(new THREE.Vector3(x, y, z));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  const geometry = new THREE.TubeGeometry(curve, 80, 0.075, 7, false);

  const clip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), -X_SPAN);
  const material = new THREE.MeshStandardMaterial({
    color: 0x081b2c,
    roughness: 0.45,
    metalness: 0.15,
    emissive: 0x081b2c,
    emissiveIntensity: 0,
    clippingPlanes: [clip],
  });
  const mesh = new THREE.Mesh(geometry, material);

  return {
    mesh,
    update(reveal: number, color: THREE.ColorRepresentation, glow: number) {
      const r = Math.min(Math.max(reveal, 0), 1);
      /* plane x <= constant is kept; sweep the constant across the span */
      clip.constant = -X_SPAN + r * X_SPAN * 2.05;
      mesh.visible = r > 0.005;
      material.color.set(color);
      material.emissive.set(color);
      material.emissiveIntensity = glow * 0.5;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
