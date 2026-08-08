"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useReducedMotion } from "motion/react";

/* Stripe's hero graphic is a gradient-mesh shader: a flowing colour field
   blended by noise, not a shape drawn with lines. Two SVG passes — thin
   threads, then blurred solid bands — got closer by approximating the blend
   with a Gaussian blur, but a blur only smooths fixed overlaps; it can't
   flow the way an actual noise field does, and it still risked a visible
   edge wherever a band's blur fell off. This is the real technique: a
   full-screen WebGL plane, a 3D simplex noise field warping itself and
   mixing heddle's own five --gradient-thread hues, its edges feathered
   (not hard-masked to a band shape) so the wrapping div's own bounds —
   already tuned to sit behind the code-window column and bleed up past
   the nav — are what give it a shape, and the shader just fills them.
   Heddle's own colours, Stripe's own rendering idea, properly this time.

   No draw-in here — a shader has no path length to measure, so it just
   fades the canvas in over the first second and lets the noise field run
   continuously from t=0. Reduced motion renders nothing: no WebGL context,
   no animation loop, just the static CSS gradient fallback below. */
const VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uColor1;
  uniform vec3 uColor2;
  uniform vec3 uColor3;
  uniform vec3 uColor4;
  uniform vec3 uColor5;
  varying vec2 vUv;

  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289(i);
    vec4 p = permute(permute(permute(
               i.z + vec4(0.0, i1.z, i2.z, 1.0))
             + i.y + vec4(0.0, i1.y, i2.y, 1.0))
             + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }

  void main() {
    vec2 st = vUv;
    st.x *= uResolution.x / uResolution.y;

    float t = uTime * 0.06;

    vec2 warp = vec2(
      snoise(vec3(st * 1.4, t)),
      snoise(vec3(st * 1.4 + 30.0, t))
    ) * 0.35;
    vec2 wuv = st + warp;

    float n1 = snoise(vec3(wuv * 1.1, t)) * 0.5 + 0.5;
    float n2 = snoise(vec3(wuv * 1.6 + 4.0, t + 1.3)) * 0.5 + 0.5;
    float n3 = snoise(vec3(wuv * 2.0 - 2.0, t + 2.6)) * 0.5 + 0.5;
    float n4 = snoise(vec3(wuv * 1.3 + 7.0, t + 3.9)) * 0.5 + 0.5;

    vec3 color = mix(uColor1, uColor2, n1);
    color = mix(color, uColor3, n2 * 0.65);
    color = mix(color, uColor4, n3 * 0.55);
    color = mix(color, uColor5, n4 * 0.45);

    float sheen = snoise(vec3(wuv * 3.2, t * 0.7 + 10.0)) * 0.5 + 0.5;
    color *= 0.82 + sheen * 0.36;

    /* vUv.y 1.0 is the canvas's own top edge, which sits well above the
       nav (the wrapping div bleeds -220px past Hero's top for exactly
       that reason) — fade it in fast so full colour is already reached
       by the time the nav's translucent backdrop-filter picks it up,
       rather than dimming out right where the glow needs to show. The
       bottom fade is slower on purpose: that edge sits at Hero's own
       bottom border, and a gradual fade reads as settling into the page
       rather than a hard clip. */
    float band =
      smoothstep(0.0, 0.14, vUv.x) *
      smoothstep(0.0, 0.14, 1.0 - vUv.x) *
      smoothstep(0.0, 0.22, vUv.y) *
      smoothstep(0.0, 0.03, 1.0 - vUv.y);

    gl_FragColor = vec4(color, band);
  }
`;

const FALLBACK_GRADIENT =
  "linear-gradient(115deg, #a960ee 0%, #ff333d 25%, #ff8a00 50%, #90e0ff 75%, #ffcb57 100%)";

export function HeroWeave() {
  const containerRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce || !containerRef.current) return;
    const container = containerRef.current;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.opacity = "0";
    renderer.domElement.style.transition = "opacity 1s ease-out";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.Camera();

    const uniforms = {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uColor1: { value: new THREE.Color("#a960ee") },
      uColor2: { value: new THREE.Color("#ff333d") },
      uColor3: { value: new THREE.Color("#ff8a00") },
      uColor4: { value: new THREE.Color("#90e0ff") },
      uColor5: { value: new THREE.Color("#ffcb57") },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    scene.add(new THREE.Mesh(geometry, material));

    function resize() {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      renderer.setSize(w, h, false);
      uniforms.uResolution.value.set(w, h);
    }
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    let raf = 0;
    const start = performance.now();
    function animate() {
      uniforms.uTime.value = (performance.now() - start) / 1000;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    }
    animate();
    requestAnimationFrame(() => {
      renderer.domElement.style.opacity = "1";
    });

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, [reduce]);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        top: -220,
        left: 0,
        right: -600,
        bottom: 0,
        overflow: "hidden",
        zIndex: -1,
        pointerEvents: "none",
        backgroundImage: reduce ? FALLBACK_GRADIENT : undefined,
        maskImage: reduce
          ? "linear-gradient(-55deg, transparent 40%, black 48%, black 62%, transparent 70%)"
          : undefined,
      }}
    />
  );
}
