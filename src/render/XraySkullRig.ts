import * as THREE from 'three';
import type { TrackedFace, TrackedPose } from '../types';
import { videoNormToStagePx, type StageProjection } from './xraySkeleton';

const SKULL_VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    vUv = uv;
    vDepth = position.z;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKULL_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying float vDepth;

  uniform sampler2D uTex;
  uniform float uTime;
  uniform float uAudioRms;
  uniform float uJawGlow;

  void main() {
    vec4 tex = texture2D(uTex, vUv);
    if (tex.a < 0.015) discard;

    float luma = dot(tex.rgb, vec3(0.299, 0.587, 0.114));

    // Crisp radiographic contrast curve (gamma 1.38) so cranial sutures, trabecular grain,
    // sphenoid eye-orbit shadows, nasal turbinates, and individual teeth + roots stay razor-sharp
    // without ever clipping to flat white!
    vec3 bone = pow(max(tex.rgb, vec3(0.0)), vec3(1.38));
    vec3 col = bone * vec3(0.76, 0.89, 0.97);

    // Subtle radiographic scan shimmer + gentle audio-reactive bone pulse (strictly bounded)
    float scan = 0.97 + 0.03 * sin(vUv.y * 220.0 - uTime * 2.8);
    col *= scan * (0.94 + uAudioRms * 0.14 + uJawGlow * 0.04);

    // Deep enclosed cavities (eye orbits & nasal aperture) stay dark & richly detailed
    float cavityShade = smoothstep(0.02, 0.18, luma);
    col = mix(vec3(0.006, 0.018, 0.038), col, cavityShade);

    gl_FragColor = vec4(col, tex.a);
  }
`;

export interface SkullPlacement {
  cx: number;
  cy: number;
  width: number;
  height: number;
  pitch: number;
  yaw: number;
  roll: number;
  jawOpen: number;
  jawShiftX: number;
  neckAnchor: { x: number; y: number };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Builds a gently curved 3D anatomical relief surface (unit quad [-0.5..+0.5])
 * so 3D head yaw & pitch produce convincing skull volume and parallax instead of a flat card.
 */
function buildCurvedSkullGeometry(segs = 24): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(1, 1, segs, segs);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i); // -0.5..+0.5
    const y = pos.getY(i); // -0.5..+0.5
    // Ellipsoidal cranial + facial forward dome curvature
    const nx = x / 0.40;
    const ny = (y - 0.02) / 0.46;
    const r2 = nx * nx + ny * ny;
    const dome = Math.sqrt(Math.max(0, 1 - Math.min(1, r2 * 0.88))) * 0.32;
    pos.setZ(i, dome);
  }
  pos.needsUpdate = true;
  return geo;
}

/**
 * Computes exact screen-space 3D skull placement & jaw articulation from FaceLandmarker
 * (478 landmarks + ARKit blendshapes), or falls back seamlessly to PoseLandmarker head points.
 */
export function computeSkullPlacement(
  face: TrackedFace | null,
  pose: TrackedPose | null,
  proj: StageProjection
): SkullPlacement | null {
  if (face) {
    const eyeL = videoNormToStagePx(face.eyeLeft.x, face.eyeLeft.y, proj);
    const eyeR = videoNormToStagePx(face.eyeRight.x, face.eyeRight.y, proj);
    const cheekL = videoNormToStagePx(face.cheekLeft.x, face.cheekLeft.y, proj);
    const cheekR = videoNormToStagePx(face.cheekRight.x, face.cheekRight.y, proj);
    const forehead = videoNormToStagePx(face.foreheadTop.x, face.foreheadTop.y, proj);
    const chin = videoNormToStagePx(face.chinBottom.x, face.chinBottom.y, proj);

    const eyeMidX = (eyeL.x + eyeR.x) * 0.5;
    const eyeMidY = (eyeL.y + eyeR.y) * 0.5;
    const eyeSpan = Math.hypot(eyeR.x - eyeL.x, eyeR.y - eyeL.y);
    const cheekSpan = Math.hypot(cheekR.x - cheekL.x, cheekR.y - cheekL.y);

    // Undo horizontal cos(yaw) foreshortening so the 3D-rotated skull projects back to true width
    const yawCos = Math.max(0.62, Math.cos(face.yaw));
    const widthFromCheek = cheekSpan / yawCos / 0.565;
    const widthFromEye = eyeSpan / yawCos / 0.262;
    const width = clamp(widthFromCheek * 0.62 + widthFromEye * 0.38, 60, proj.height * 0.95);
    const height = width * 1.03;

    // Texture coordinate calibration (measured directly on xray-cranium.png):
    // eye orbits sit at y = 0.440 from top -> +0.060 above texture center in Y-up space.
    const roll = clamp(face.roll, -0.85, 0.85);
    const upX = -Math.sin(roll);
    const upY = Math.cos(roll);

    // Place skull center so eye orbits align dead-center over the user's real eyes!
    const eyeOffsetY = 0.060 * height;
    const cx = eyeMidX - upX * eyeOffsetY;
    const cy = eyeMidY - upY * eyeOffsetY;

    // Combine blendshape jawOpen with real chin drop distance for crisp extreme yawns
    const foreheadToEye = Math.hypot(forehead.x - eyeMidX, forehead.y - eyeMidY);
    const eyeToChin = Math.hypot(chin.x - eyeMidX, chin.y - eyeMidY);
    const chinRatio = eyeToChin / Math.max(12, foreheadToEye);
    // Typical neutral chinRatio ~ 1.48..1.65; wide open mouth stretches to ~ 2.05+
    const chinJawBoost = clamp((chinRatio - 1.74) / 0.48, 0, 1);
    const jawOpen = clamp(Math.max(face.jawOpen, chinJawBoost * 0.85), 0, 1);

    // Cervical spine meets occiput cleanly right behind the jaw base
    const neckAnchor = {
      x: cx - upX * (height * 0.38),
      y: cy - upY * (height * 0.38),
    };

    return {
      cx,
      cy,
      width,
      height,
      pitch: clamp(face.pitch, -0.55, 0.55),
      yaw: clamp(face.yaw, -0.68, 0.68),
      roll,
      jawOpen,
      jawShiftX: clamp(face.jawShiftX, -1, 1),
      neckAnchor,
    };
  }

  // Fallback to 33-point PoseLandmarker when user stands far from camera
  if (pose && pose.landmarks.length >= 13) {
    const lm = pose.landmarks;
    const eyeVis = Math.min(lm[2]?.visibility ?? 0, lm[5]?.visibility ?? 0);
    const shVis = Math.min(lm[11]?.visibility ?? 0, lm[12]?.visibility ?? 0);
    if (eyeVis < 0.25 && shVis < 0.25) return null;

    const toPx = (i: number) => videoNormToStagePx(lm[i].x, lm[i].y, proj);
    const p11 = toPx(11);
    const p12 = toPx(12);
    const shoulderW = Math.hypot(p12.x - p11.x, p12.y - p11.y);
    const p2 = toPx(2);
    const p5 = toPx(5);
    const eyeL = p2.x <= p5.x ? p2 : p5;
    const eyeR = p2.x <= p5.x ? p5 : p2;
    const earL = toPx(7);
    const earR = toPx(8);
    const nose = toPx(0);

    const eyeMidX = (eyeL.x + eyeR.x) * 0.5;
    const eyeMidY = (eyeL.y + eyeR.y) * 0.5;
    const earSpan = Math.hypot(earR.x - earL.x, earR.y - earL.y);
    const eyeSpan = Math.hypot(eyeR.x - eyeL.x, eyeR.y - eyeL.y);
    const headBonyW = clamp(
      Math.max(earSpan * 1.05, eyeSpan * 2.35, shoulderW * 0.44),
      shoulderW * 0.38,
      shoulderW * 0.64
    );
    const width = clamp(headBonyW / 0.58, 52, proj.height * 0.9);
    const height = width * 1.03;

    const roll = clamp(Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x), -0.85, 0.85);
    const upX = -Math.sin(roll);
    const upY = Math.cos(roll);
    const rx = Math.cos(roll);
    const ry = Math.sin(roll);
    const noseOff = (nose.x - eyeMidX) * rx + (nose.y - eyeMidY) * ry;
    const yaw = clamp((noseOff / Math.max(16, headBonyW * 0.5)) * 0.65, -0.58, 0.58);

    const cx = eyeMidX - upX * (0.060 * height);
    const cy = eyeMidY - upY * (0.060 * height);

    return {
      cx,
      cy,
      width,
      height,
      pitch: 0,
      yaw,
      roll,
      jawOpen: 0.04,
      jawShiftX: 0,
      neckAnchor: {
        x: cx - upX * (height * 0.38),
        y: cy - upY * (height * 0.38),
      },
    };
  }

  return null;
}

/**
 * Real-time 3D articulated medical X-Ray skull rig (Cranium + TMJ-hinged Mandible).
 * Renders inside StageRenderer's HDR fxScene so bone highlights receive natural fluoroscopy bloom.
 */
export class XraySkullRig {
  public readonly root = new THREE.Group();
  private readonly mandiblePivot = new THREE.Group();

  private readonly craniumGeo: THREE.BufferGeometry;
  private readonly mandibleGeo: THREE.BufferGeometry;
  private readonly craniumMat: THREE.ShaderMaterial;
  private readonly mandibleMat: THREE.ShaderMaterial;
  private readonly craniumMesh: THREE.Mesh;
  private readonly mandibleMesh: THREE.Mesh;

  private craniumTex: THREE.Texture | null = null;
  private mandibleTex: THREE.Texture | null = null;
  private loadedCount = 0;

  constructor() {
    this.root.visible = false;

    const dummyTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    dummyTex.needsUpdate = true;

    this.craniumGeo = buildCurvedSkullGeometry(24);
    this.mandibleGeo = buildCurvedSkullGeometry(20);

    // Offset mandible mesh relative to TMJ pivot so rotating mandiblePivot.rotation.x
    // physically hinges the lower jaw around the real temporomandibular joint (y = -0.07, z = -0.18)!
    const tmjY = -0.07;
    const tmjZ = -0.18;
    this.mandiblePivot.position.set(0, tmjY, tmjZ);

    this.craniumMat = this.createShaderMat(dummyTex);
    this.mandibleMat = this.createShaderMat(dummyTex);

    this.mandibleMesh = new THREE.Mesh(this.mandibleGeo, this.mandibleMat);
    this.mandibleMesh.position.set(0, -tmjY, -tmjZ);
    this.mandibleMesh.renderOrder = 1;
    this.mandibleMesh.frustumCulled = false;

    this.craniumMesh = new THREE.Mesh(this.craniumGeo, this.craniumMat);
    this.craniumMesh.renderOrder = 2;
    this.craniumMesh.frustumCulled = false;

    this.mandiblePivot.add(this.mandibleMesh);
    this.root.add(this.mandiblePivot);
    this.root.add(this.craniumMesh);

    this.loadTextures();
  }

  private createShaderMat(tex: THREE.Texture): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: SKULL_VERT,
      fragmentShader: SKULL_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTex: { value: tex },
        uTime: { value: 0 },
        uAudioRms: { value: 0 },
        uJawGlow: { value: 0 },
      },
    });
  }

  private loadTextures(): void {
    const loader = new THREE.TextureLoader();
    const configure = (t: THREE.Texture) => {
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
    };

    loader.load('/assets/xray-cranium.png', (tex) => {
      configure(tex);
      this.craniumTex = tex;
      this.craniumMat.uniforms.uTex.value = tex;
      this.loadedCount++;
    });

    loader.load('/assets/xray-mandible.png', (tex) => {
      configure(tex);
      this.mandibleTex = tex;
      this.mandibleMat.uniforms.uTex.value = tex;
      this.loadedCount++;
    });
  }

  isReady(): boolean {
    return this.loadedCount >= 2;
  }

  /**
   * Updates the 3D articulated skull rig for the current frame.
   * Returns the live neck anchor point if rendered so the cervical spine joins cleanly beneath the skull.
   */
  update(
    active: boolean,
    face: TrackedFace | null,
    pose: TrackedPose | null,
    proj: StageProjection,
    elapsedSec: number,
    audioRms: number
  ): { x: number; y: number } | null {
    if (!active || !this.isReady()) {
      this.root.visible = false;
      return null;
    }

    const placement = computeSkullPlacement(face, pose, proj);
    if (!placement) {
      this.root.visible = false;
      return null;
    }

    this.root.visible = true;
    this.root.position.set(placement.cx, placement.cy, 0);
    // Keep Z scale proportional to width so 3D rotation has true physical depth
    this.root.scale.set(placement.width, placement.height, placement.width);
    this.root.rotation.order = 'ZYX';
    this.root.rotation.set(
      placement.pitch * 0.55,
      placement.yaw * 0.72,
      placement.roll
    );

    // Articulated Mandible TMJ Hinge + Vertical Jaw Drop + Lateral Jaw Shift!
    // At jawOpen = 0, lift by +0.037 to close the source radiograph's ~3.7% resting gap to a flush bite.
    // As jawOpen -> 1.0, positive X rotation swings the lower teeth/chin down & slightly back around
    // the TMJ condyle axis while keeping the ascending ramus seamlessly locked under the cheekbones!
    const jaw = placement.jawOpen;
    const tmjY = -0.07;
    const tmjZ = -0.18;
    const biteCloseLift = 0.037;
    const openDrop = jaw * 0.055;

    this.mandiblePivot.position.set(
      placement.jawShiftX * 0.048,
      tmjY + biteCloseLift - openDrop,
      tmjZ
    );
    this.mandiblePivot.rotation.set(
      jaw * 0.34,
      placement.jawShiftX * 0.12,
      placement.jawShiftX * 0.05
    );

    this.craniumMat.uniforms.uTime.value = elapsedSec;
    this.craniumMat.uniforms.uAudioRms.value = audioRms;
    this.craniumMat.uniforms.uJawGlow.value = jaw * 0.4;

    this.mandibleMat.uniforms.uTime.value = elapsedSec;
    this.mandibleMat.uniforms.uAudioRms.value = audioRms;
    this.mandibleMat.uniforms.uJawGlow.value = jaw;

    return placement.neckAnchor;
  }

  dispose(): void {
    this.craniumGeo.dispose();
    this.mandibleGeo.dispose();
    this.craniumMat.dispose();
    this.mandibleMat.dispose();
    this.craniumTex?.dispose();
    this.mandibleTex?.dispose();
  }
}
