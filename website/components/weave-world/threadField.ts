/* The loom's geometry: a ply of three thick yarn ribbons twisting around
   one shared cubic-bezier spine, plus the weft — a fourth ribbon in the
   same spun-fiber style that crosses the frame horizontally and weaves
   through the ply, oscillating in z so depth-testing makes it pass over
   and under the strands like a real pick through a shed.

   Every thread is a GPU ribbon: the vertex shader places it (the ply
   strands orbit the spine; the weft runs its own crossing spine with a z
   wave), and the shared fragment shader draws spun-fiber striations,
   cylindrical shading, a silky off-centre sheen, and depth-shadow. The
   weft reveals itself left-to-right through the uReveal uniform (the ply
   strands pin it fully open) — no clipping planes needed.

   Scroll reaches the ply through uShift (twist advance) and uOpen — the
   shed: at 1 the ply lies closed; opened, the strands separate and the
   weft's ±0.12 z-wave passes through the gap. Positions are in the design
   space of the orthographic cover box in WeaveWorld. */

import * as THREE from "three";

/* Three plies, five brand hues (--gradient-thread's stops) spread across
   them. No pink — the brand explicitly retired it. */
const PLY_STOPS: [string, string, string][] = [
  ["#d8e6ff", "#90e0ff", "#a960ee"], // pale blue -> cyan -> purple
  ["#ffe08a", "#ffcb57", "#ff8a00"], // pale gold -> gold -> orange
  ["#ff5c4d", "#ff333d", "#a960ee"], // ember -> red -> purple
];

/* The weft's two liveries, crossed continuously in update(): navy ink on
   the paper ground, pale cyan glow on the dark bands and dark theme. */
const WEFT_INK: [string, string, string] = ["#133e5c", "#081b2c", "#0e2f4a"];
const WEFT_GLOW: [string, string, string] = ["#d9f9ff", "#90e0ff", "#45deff"];

const BEZ_HELPERS = /* glsl */ `
  vec2 bez(vec2 a, vec2 b, vec2 c, vec2 d, float t) {
    float s = 1.0 - t;
    return s*s*s*a + 3.0*s*s*t*b + 3.0*s*t*t*c + t*t*t*d;
  }
  vec2 bezTan(vec2 a, vec2 b, vec2 c, vec2 d, float t) {
    float s = 1.0 - t;
    return 3.0*s*s*(b-a) + 6.0*s*t*(c-b) + 3.0*t*t*(d-c);
  }
`;

const PLY_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uPhase;   // where this thread sits in the ply
  uniform float uRadius;  // base orbit radius around the shared spine
  uniform float uThick;   // thread thickness
  uniform float uTwist;
  uniform float uOpen;    // shed: orbit-radius multiplier from scroll
  uniform float uShift;   // twist advance from scroll
  varying float vT;
  varying float vAcross;
  varying float vDepth;

  ${"" /* bezier helpers injected below */}
  __BEZ__

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

    float theta = t * uTwist + uPhase + uShift
                + 0.30 * sin(uTime * 0.20)
                + 0.06 * sin(t * 9.0 + uTime * 0.8);
    float c = cos(theta);
    float s = sin(theta);

    float r = uRadius * uOpen
            * (1.0 + 0.10 * sin(t * 5.0 + uTime * 0.5 + uPhase));

    pos += nor * (r * c + across * uThick * 0.5);

    vT = t;
    vAcross = across;
    vDepth = s;
    // Depth from the orbit so crossings occlude like a real braid — and so
    // the weft's own z-wave threads between the front and back strands.
    gl_Position = projectionMatrix * modelViewMatrix
                * vec4(pos, s * uRadius * uOpen, 1.0);
  }
`.replace("__BEZ__", BEZ_HELPERS);

const WEFT_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uThick;
  varying float vT;
  varying float vAcross;
  varying float vDepth;

  __BEZ__

  void main() {
    float t = uv.x;
    float across = uv.y * 2.0 - 1.0;

    // The pick: enters frame-left, sags, exits low frame-right, crossing
    // the ply's sweep on the way.
    vec2 Q0 = vec2(-1.45,  0.42);
    vec2 Q1 = vec2(-0.10,  0.06 + 0.04 * sin(uTime * 0.31));
    vec2 Q2 = vec2( 0.95, -0.12 + 0.05 * sin(uTime * 0.23 + 1.7));
    vec2 Q3 = vec2( 2.05, -0.52);

    vec2 pos = bez(Q0, Q1, Q2, Q3, t);
    vec2 tang = normalize(bezTan(Q0, Q1, Q2, Q3, t));
    vec2 nor = vec2(-tang.y, tang.x);

    pos += nor * (across * uThick * 0.5);

    // The weave: a z wave inside the ply's orbit band, so depth testing
    // sends the weft in front of one strand and behind the next.
    float z = sin(t * 14.0 + uTime * 0.25) * 0.12;

    vT = t;
    vAcross = across;
    vDepth = z / 0.12;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, z, 1.0);
  }
`.replace("__BEZ__", BEZ_HELPERS);

const FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uGlow;    // dark-band chapters push the thread brighter
  uniform float uPaper;   // 1 on the light paper ground, 0 on dark grounds
  uniform float uReveal;  // show vT < uReveal; ply strands pin this open
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
    vec3 col = mix(mix(uColA, uColB, smoothstep(0.0, 0.45, vT)),
                   uColC, smoothstep(0.45, 1.0, vT));

    float spiral = vAcross * 34.0 + vT * 150.0;
    float f = sin(spiral + noise(vec2(vT * 40.0, vAcross * 5.0)) * 2.5);
    f *= 0.7 + 0.3 * noise(vec2(vT * 80.0, vAcross * 10.0));
    col *= 1.0 + 0.10 * f;

    float shade = sqrt(max(0.0, 1.0 - vAcross * vAcross));
    col *= 0.35 + 0.65 * shade;
    float sheen = exp(-pow((vAcross + 0.35) * 3.0, 2.0));
    col += sheen * 0.30 * vec3(1.0, 0.97, 0.95) * (1.0 - 0.5 * uPaper);

    col *= 0.68 + 0.32 * smoothstep(-1.0, 1.0, vDepth);

    col *= 0.94 + 0.12 * sin(vT * 16.0 - uTime * 1.3);

    col = mix(col, col * col * 1.25, uPaper * 0.45);
    col *= 1.0 + uGlow * 0.45 * (1.0 - uPaper);

    float alpha = smoothstep(1.0, 0.93, abs(vAcross))
                * smoothstep(0.0, 0.05, vT) * smoothstep(1.0, 0.95, vT)
                * (1.0 - smoothstep(uReveal - 0.04, uReveal + 0.01, vT));

    gl_FragColor = vec4(col, alpha);
  }
`;

function ribbonMaterial(
  vertexShader: string,
  stops: [string, string, string],
  extra: Record<string, { value: unknown }>,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uGlow: { value: 0 },
      uPaper: { value: 1 },
      uReveal: { value: 2 },
      uColA: { value: new THREE.Color(stops[0]) },
      uColB: { value: new THREE.Color(stops[1]) },
      uColC: { value: new THREE.Color(stops[2]) },
      ...extra,
    },
    side: THREE.DoubleSide,
    /* Not blended: the ribbons depth-write so they can occlude each other,
       and a blended soft edge composites against whatever drew first —
       over the paper ground that left a white fringe wherever one thread
       edged across another. Alpha-to-coverage hands the fragment alpha to
       MSAA instead (the renderer requests antialias), so edges stay soft
       with no blend-order artifact. */
    transparent: false,
    alphaToCoverage: true,
    depthTest: true,
    depthWrite: true,
  });
}

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
    const material = ribbonMaterial(PLY_VERTEX, stops, {
      uPhase: { value: (index * Math.PI * 2) / 3 },
      uRadius: { value: 0.17 },
      uThick: { value: 0.15 },
      uTwist: { value: 4.6 },
      uOpen: { value: 1 },
      uShift: { value: 0 },
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

export type WeftRibbon = {
  mesh: THREE.Mesh;
  update(time: number, reveal: number, bandMix: number, paper: number): void;
  dispose(): void;
};

export function createWeftRibbon(): WeftRibbon {
  const geometry = new THREE.PlaneGeometry(1, 1, 500, 12);
  const material = ribbonMaterial(WEFT_VERTEX, WEFT_INK, {
    uThick: { value: 0.055 },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  const ink = WEFT_INK.map((c) => new THREE.Color(c));
  const glowStops = WEFT_GLOW.map((c) => new THREE.Color(c));
  const mixed = [new THREE.Color(), new THREE.Color(), new THREE.Color()];

  return {
    mesh,
    update(time, reveal, bandMix, paper) {
      material.uniforms.uTime.value = time;
      material.uniforms.uReveal.value = Math.min(Math.max(reveal, 0), 1) * 1.06;
      material.uniforms.uPaper.value = paper;
      material.uniforms.uGlow.value = bandMix;
      for (let i = 0; i < 3; i++) {
        mixed[i].copy(ink[i]).lerp(glowStops[i], bandMix);
      }
      material.uniforms.uColA.value = mixed[0];
      material.uniforms.uColB.value = mixed[1];
      material.uniforms.uColC.value = mixed[2];
      mesh.visible = reveal > 0.005;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
