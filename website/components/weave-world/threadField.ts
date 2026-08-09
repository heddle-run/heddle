/* The loom's geometry, third pass. The first drew flat fat-lines (read as a
   plot grid); the second drew ~54 lit tubes (read as a thread *field*). This
   is a ply: three thick yarn ribbons twisting around one shared cubic-bezier
   spine that sweeps diagonally across the frame — each thread a GPU ribbon
   whose vertex shader orbits it around the spine and whose fragment shader
   draws spun-fiber striations, cylindrical shading, a silky off-centre
   sheen, and depth-shadow on the far side of the twist, so crossings occlude
   like a real braid.

   Scroll reaches the shader through two uniforms: uShift advances the
   braid's twist as the page moves, and uOpen scales the orbit radius — the
   shed, literally: at 1 the ply lies closed; opened, the three strands
   separate and the weft tube (z = 0, between the front and back of the
   orbit) passes through the gap. The weft is revealed by a clipping plane,
   which needs renderer.localClippingEnabled = true (WeaveWorld sets it).

   Positions are in the reference design space of the orthographic cover box
   in WeaveWorld (roughly x ∈ [-1, 2], y ∈ [-1.6, 1.6]), not the old
   perspective-world units. */

import * as THREE from "three";

/* Three plies, five brand hues (--gradient-thread's stops) spread across
   them; each thread drifts along its own length. No pink — the brand
   explicitly retired it. */
const PLY_STOPS: [string, string, string][] = [
  ["#d8e6ff", "#90e0ff", "#a960ee"], // pale blue -> cyan -> purple
  ["#ffe08a", "#ffcb57", "#ff8a00"], // pale gold -> gold -> orange
  ["#ff5c4d", "#ff333d", "#a960ee"], // ember -> red -> purple
];

const VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uPhase;   // where this thread sits in the ply
  uniform float uRadius;  // base orbit radius around the shared spine
  uniform float uThick;   // thread thickness
  uniform float uTwist;
  uniform float uOpen;    // shed: orbit-radius multiplier from scroll
  uniform float uShift;   // twist advance from scroll
  varying float vT;       // along the thread
  varying float vAcross;  // across the thread, -1..1
  varying float vDepth;   // front/back of the orbit, for shading

  vec2 bez(vec2 a, vec2 b, vec2 c, vec2 d, float t) {
    float s = 1.0 - t;
    return s*s*s*a + 3.0*s*s*t*b + 3.0*s*t*t*c + t*t*t*d;
  }
  vec2 bezTan(vec2 a, vec2 b, vec2 c, vec2 d, float t) {
    float s = 1.0 - t;
    return 3.0*s*s*(b-a) + 6.0*s*t*(c-b) + 3.0*t*t*(d-c);
  }

  void main() {
    float t = uv.x;
    float across = uv.y * 2.0 - 1.0;

    // Shared spine: enters off the top, bows left, exits bottom-right.
    vec2 P0 = vec2( 0.18,  1.60);
    vec2 P1 = vec2(-0.50,  0.50 + 0.05 * sin(uTime * 0.37));
    vec2 P2 = vec2( 1.65, -0.05 + 0.06 * sin(uTime * 0.29 + 2.1));
    vec2 P3 = vec2( 0.68, -1.60);

    vec2 pos = bez(P0, P1, P2, P3, t);
    vec2 tang = normalize(bezTan(P0, P1, P2, P3, t));
    vec2 nor = vec2(-tang.y, tang.x);

    // The threads ply around each other along the spine; the whole twist
    // sways gently, and scroll advances it through uShift.
    float theta = t * uTwist + uPhase + uShift
                + 0.30 * sin(uTime * 0.20)
                + 0.06 * sin(t * 9.0 + uTime * 0.8);
    float c = cos(theta);
    float s = sin(theta);

    // A touch of breathing keeps the braid supple; uOpen is the shed.
    float r = uRadius * uOpen
            * (1.0 + 0.10 * sin(t * 5.0 + uTime * 0.5 + uPhase));

    pos += nor * (r * c + across * uThick * 0.5);

    vT = t;
    vAcross = across;
    vDepth = s;
    // Depth from the orbit so crossings occlude like a real braid — and so
    // the weft tube at z = 0 threads between the front and back strands.
    gl_Position = projectionMatrix * modelViewMatrix
                * vec4(pos, s * uRadius * uOpen, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uGlow;   // dark-band chapters push the thread brighter
  uniform float uPaper;  // 1 on the light paper ground, 0 on dark grounds
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColC;
  varying float vT;
  varying float vAcross;
  varying float vDepth;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
               mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
  }

  void main() {
    // Color drifts along the length of the thread.
    vec3 col = mix(mix(uColA, uColB, smoothstep(0.0, 0.45, vT)),
                   uColC, smoothstep(0.45, 1.0, vT));

    // Spun-fiber striations spiralling around the yarn.
    float spiral = vAcross * 34.0 + vT * 150.0;
    float f = sin(spiral + noise(vec2(vT * 40.0, vAcross * 5.0)) * 2.5);
    f *= 0.7 + 0.3 * noise(vec2(vT * 80.0, vAcross * 10.0));
    col *= 1.0 + 0.10 * f;

    // Cylindrical shading with a silky highlight off-center.
    float shade = sqrt(max(0.0, 1.0 - vAcross * vAcross));
    col *= 0.35 + 0.65 * shade;
    float sheen = exp(-pow((vAcross + 0.35) * 3.0, 2.0));
    col += sheen * 0.30 * vec3(1.0, 0.97, 0.95) * (1.0 - 0.5 * uPaper);

    // Threads on the far side of the ply sit in soft shadow.
    col *= 0.68 + 0.32 * smoothstep(-1.0, 1.0, vDepth);

    // Soft glints travelling down the thread.
    col *= 0.94 + 0.12 * sin(vT * 16.0 - uTime * 1.3);

    // Pastel stops wash out on white paper, so deepen there; on the navy
    // bands and the dark theme, glow instead.
    col = mix(col, col * col * 1.25, uPaper * 0.45);
    col *= 1.0 + uGlow * 0.45 * (1.0 - uPaper);

    // Round profile; fade the tips off-screen.
    float alpha = smoothstep(1.0, 0.93, abs(vAcross))
                * smoothstep(0.0, 0.05, vT) * smoothstep(1.0, 0.95, vT);

    gl_FragColor = vec4(col, alpha);
  }
`;

export type Ply = {
  group: THREE.Group;
  update(
    time: number,
    open: number,
    glow: number,
    paper: number,
    shift: number,
  ): void;
  dispose(): void;
};

export function createPly(): Ply {
  const group = new THREE.Group();
  const geometries: THREE.PlaneGeometry[] = [];
  const materials: THREE.ShaderMaterial[] = [];

  PLY_STOPS.forEach((stops, index) => {
    const geometry = new THREE.PlaneGeometry(1, 1, 500, 16);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uPhase: { value: (index * Math.PI * 2) / 3 },
        uRadius: { value: 0.17 },
        uThick: { value: 0.15 },
        uTwist: { value: 4.6 },
        uOpen: { value: 1 },
        uShift: { value: 0 },
        uGlow: { value: 0 },
        uPaper: { value: 1 },
        uColA: { value: new THREE.Color(stops[0]) },
        uColB: { value: new THREE.Color(stops[1]) },
        uColC: { value: new THREE.Color(stops[2]) },
      },
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: true,
      depthWrite: true,
      alphaTest: 0.4,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    group.add(mesh);
    geometries.push(geometry);
    materials.push(material);
  });

  return {
    group,
    update(time, open, glow, paper, shift) {
      for (const material of materials) {
        material.uniforms.uTime.value = time;
        material.uniforms.uOpen.value = open;
        material.uniforms.uGlow.value = glow;
        material.uniforms.uPaper.value = paper;
        material.uniforms.uShift.value = shift;
      }
    },
    dispose() {
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
    },
  };
}

export type WeftLine = {
  mesh: THREE.Mesh;
  update(reveal: number, color: THREE.ColorRepresentation, glow: number): void;
  dispose(): void;
};

export function createWeftLine(): WeftLine {
  const X_FROM = -1.2;
  const X_TO = 2.2;
  const points: THREE.Vector3[] = [];
  const STEPS = 48;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const x = X_FROM + t * (X_TO - X_FROM);
    /* A slight counter-diagonal against the spine, with sag between passes.
       z = 0 puts it exactly between the ply's front and back strands, so an
       open shed lets it through and a closed one weaves over it. */
    const y = 0.3 - t * 0.5 + Math.sin(t * Math.PI) * -0.06
            + Math.sin(t * Math.PI * 5) * 0.02;
    points.push(new THREE.Vector3(x, y, 0));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  const geometry = new THREE.TubeGeometry(curve, 96, 0.016, 7, false);

  const clip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), X_FROM);
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
    update(reveal, color, glow) {
      const r = Math.min(Math.max(reveal, 0), 1);
      clip.constant = X_FROM + r * (X_TO - X_FROM) * 1.02;
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
