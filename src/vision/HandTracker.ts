import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  ImageSegmenter,
  PoseLandmarker,
} from '@mediapipe/tasks-vision';
import { isHandBackFacing } from '../core/BgSwipeDetector';
import { LandmarkSmoother, OneEuroFilter1D } from './OneEuroFilter';
import type {
  ActiveFinger,
  PoseLandmark,
  TrackedFace,
  TrackedHand,
  TrackedPose,
  Vec2,
  Vec3,
} from '../types';

export interface SegmentationFrame {
  data: Uint8Array;
  width: number;
  height: number;
}

interface HandSlot {
  id: string;
  smoother: LandmarkSmoother;
  pinchActive: boolean;
  lastSeenMs: number;
  lastWrist: Vec2;
  lastPalmCenter: Vec2;
  prevFingerPos: Map<number, Vec2>;
}

const FINGERTIPS = [4, 8, 12, 16, 20] as const;

const LOCAL_WASM_ROOT = '/mediapipe/wasm';
const CDN_WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm';

const LOCAL_HAND_MODEL = '/mediapipe/models/hand_landmarker.task';
const CDN_HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const LOCAL_SEG_MODEL = '/mediapipe/models/selfie_segmenter.tflite';
const CDN_SEG_MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

const LOCAL_POSE_MODEL = '/mediapipe/models/pose_landmarker_lite.task';
const CDN_POSE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const LOCAL_FACE_MODEL = '/mediapipe/models/face_landmarker.task';
const CDN_FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

async function assetExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

export class HandTracker {
  private vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private handLandmarker: HandLandmarker | null = null;
  private segmenter: ImageSegmenter | null = null;
  private segmenterLoading: Promise<void> | null = null;
  private poseLandmarker: PoseLandmarker | null = null;
  private poseLoading: Promise<void> | null = null;
  private faceLandmarker: FaceLandmarker | null = null;
  private faceLoading: Promise<void> | null = null;

  private slots: HandSlot[] = [this.createSlot('hand-0'), this.createSlot('hand-1')];
  private lastVideoTime = -1;
  private lastTimestampMs = 0;

  private poseSmoother = new LandmarkSmoother(33, 1.8, 0.12);
  private lastPoseVideoTime = -1;
  private lastPoseTimestampMs = 0;
  private lastPoseSeenMs = -10_000;
  private cachedPose: TrackedPose | null = null;

  // 11 key face anchor points + 6 scalar pose/jaw signals smoothed with crisp 1€ filters
  private facePtSmoother = new LandmarkSmoother(11, 2.8, 0.22);
  private faceScalarFilters = {
    pitch: new OneEuroFilter1D(2.4, 0.18),
    yaw: new OneEuroFilter1D(2.4, 0.18),
    roll: new OneEuroFilter1D(2.6, 0.20),
    jawOpen: new OneEuroFilter1D(4.2, 0.35),
    jawShiftX: new OneEuroFilter1D(3.5, 0.25),
    mouthStretch: new OneEuroFilter1D(3.2, 0.22),
  };
  private lastFaceVideoTime = -1;
  private lastFaceTimestampMs = 0;
  private lastFaceSeenMs = -10_000;
  private cachedFace: TrackedFace | null = null;

  private segMaskBuffer: Uint8Array | null = null;
  private segWidth = 0;
  private segHeight = 0;
  private lastSegMs = -10_000;

  private createSlot(id: string): HandSlot {
    return {
      id,
      smoother: new LandmarkSmoother(21, 2.3, 0.16),
      pinchActive: false,
      lastSeenMs: -10_000,
      lastWrist: { x: 0.5, y: 0.5 },
      lastPalmCenter: { x: 0.5, y: 0.5 },
      prevFingerPos: new Map(),
    };
  }

  async init(onStatus?: (key: 'statusLoadingVision' | 'statusLoadingHand') => void): Promise<void> {
    if (this.handLandmarker) return;

    onStatus?.('statusLoadingVision');
    const wasmRoot = (await assetExists(`${LOCAL_WASM_ROOT}/vision_wasm_internal.wasm`))
      ? LOCAL_WASM_ROOT
      : CDN_WASM_ROOT;

    this.vision = await FilesetResolver.forVisionTasks(wasmRoot);

    onStatus?.('statusLoadingHand');
    const handModelPath = (await assetExists(LOCAL_HAND_MODEL))
      ? LOCAL_HAND_MODEL
      : CDN_HAND_MODEL;

    try {
      this.handLandmarker = await HandLandmarker.createFromOptions(this.vision, {
        baseOptions: {
          modelAssetPath: handModelPath,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.52,
        minHandPresenceConfidence: 0.52,
        minTrackingConfidence: 0.48,
      });
    } catch {
      // Fallback to CPU delegate if WebGL GPU delegate isn't available
      this.handLandmarker = await HandLandmarker.createFromOptions(this.vision, {
        baseOptions: {
          modelAssetPath: handModelPath,
          delegate: 'CPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.52,
        minHandPresenceConfidence: 0.52,
        minTrackingConfidence: 0.48,
      });
    }
  }

  async ensureSegmenter(): Promise<void> {
    if (this.segmenter) return;
    if (this.segmenterLoading) return this.segmenterLoading;

    this.segmenterLoading = (async () => {
      if (!this.vision) {
        const wasmRoot = (await assetExists(`${LOCAL_WASM_ROOT}/vision_wasm_internal.wasm`))
          ? LOCAL_WASM_ROOT
          : CDN_WASM_ROOT;
        this.vision = await FilesetResolver.forVisionTasks(wasmRoot);
      }

      const segModelPath = (await assetExists(LOCAL_SEG_MODEL))
        ? LOCAL_SEG_MODEL
        : CDN_SEG_MODEL;

      try {
        this.segmenter = await ImageSegmenter.createFromOptions(this.vision, {
          baseOptions: {
            modelAssetPath: segModelPath,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          outputCategoryMask: false,
          outputConfidenceMasks: true,
        });
      } catch (err) {
        console.warn('[HandTracker] Selfie segmenter GPU failed, trying CPU:', err);
        try {
          this.segmenter = await ImageSegmenter.createFromOptions(this.vision, {
            baseOptions: {
              modelAssetPath: segModelPath,
              delegate: 'CPU',
            },
            runningMode: 'VIDEO',
            outputCategoryMask: false,
            outputConfidenceMasks: true,
          });
        } catch (cpuErr) {
          console.warn('[HandTracker] Selfie segmenter unavailable:', cpuErr);
        }
      }
    })();

    return this.segmenterLoading;
  }

  async ensurePoseLandmarker(): Promise<void> {
    if (this.poseLandmarker) return;
    if (this.poseLoading) return this.poseLoading;

    this.poseLoading = (async () => {
      if (!this.vision) {
        const wasmRoot = (await assetExists(`${LOCAL_WASM_ROOT}/vision_wasm_internal.wasm`))
          ? LOCAL_WASM_ROOT
          : CDN_WASM_ROOT;
        this.vision = await FilesetResolver.forVisionTasks(wasmRoot);
      }

      const poseModelPath = (await assetExists(LOCAL_POSE_MODEL))
        ? LOCAL_POSE_MODEL
        : CDN_POSE_MODEL;

      try {
        this.poseLandmarker = await PoseLandmarker.createFromOptions(this.vision, {
          baseOptions: {
            modelAssetPath: poseModelPath,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.45,
          minPosePresenceConfidence: 0.45,
          minTrackingConfidence: 0.45,
        });
      } catch (err) {
        console.warn('[HandTracker] PoseLandmarker GPU failed, trying CPU:', err);
        try {
          this.poseLandmarker = await PoseLandmarker.createFromOptions(this.vision, {
            baseOptions: {
              modelAssetPath: poseModelPath,
              delegate: 'CPU',
            },
            runningMode: 'VIDEO',
            numPoses: 1,
            minPoseDetectionConfidence: 0.45,
            minPosePresenceConfidence: 0.45,
            minTrackingConfidence: 0.45,
          });
        } catch (cpuErr) {
          console.warn('[HandTracker] PoseLandmarker unavailable:', cpuErr);
        }
      }
    })();

    return this.poseLoading;
  }

  async ensureFaceLandmarker(): Promise<void> {
    if (this.faceLandmarker) return;
    if (this.faceLoading) return this.faceLoading;

    this.faceLoading = (async () => {
      if (!this.vision) {
        const wasmRoot = (await assetExists(`${LOCAL_WASM_ROOT}/vision_wasm_internal.wasm`))
          ? LOCAL_WASM_ROOT
          : CDN_WASM_ROOT;
        this.vision = await FilesetResolver.forVisionTasks(wasmRoot);
      }

      const faceModelPath = (await assetExists(LOCAL_FACE_MODEL))
        ? LOCAL_FACE_MODEL
        : CDN_FACE_MODEL;

      const options = {
        runningMode: 'VIDEO' as const,
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: 0.45,
        minFacePresenceConfidence: 0.45,
        minTrackingConfidence: 0.45,
      };

      try {
        this.faceLandmarker = await FaceLandmarker.createFromOptions(this.vision, {
          baseOptions: {
            modelAssetPath: faceModelPath,
            delegate: 'GPU',
          },
          ...options,
        });
      } catch (err) {
        console.warn('[HandTracker] FaceLandmarker GPU failed, trying CPU:', err);
        try {
          this.faceLandmarker = await FaceLandmarker.createFromOptions(this.vision, {
            baseOptions: {
              modelAssetPath: faceModelPath,
              delegate: 'CPU',
            },
            ...options,
          });
        } catch (cpuErr) {
          console.warn('[HandTracker] FaceLandmarker unavailable:', cpuErr);
        }
      }
    })();

    return this.faceLoading;
  }

  detectHands(
    video: HTMLVideoElement,
    nowMs: number,
    mirror: boolean
  ): TrackedHand[] | null {
    if (!this.handLandmarker || video.readyState < 2) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;

    const ts = Math.max(nowMs, this.lastTimestampMs + 1);
    const dtSec = Math.max(1 / 120, Math.min(0.1, (ts - this.lastTimestampMs) / 1000));
    this.lastTimestampMs = ts;

    const res = this.handLandmarker.detectForVideo(video, ts);
    const rawHands = res.landmarks ?? [];
    if (rawHands.length === 0) {
      // Decay old slots cleanly after brief disappearance
      for (const slot of this.slots) {
        if (ts - slot.lastSeenMs > 300) {
          slot.smoother.reset();
          slot.pinchActive = false;
          slot.prevFingerPos.clear();
        }
      }
      return [];
    }

    // Match detected hands to persistent slots by nearest wrist distance
    const assignments = this.assignSlots(rawHands, mirror, ts);
    const tracked: TrackedHand[] = [];

    for (let i = 0; i < rawHands.length; i++) {
      const slot = assignments[i];
      if (!slot) continue;

      const raw = rawHands[i].map((p) => ({
        x: mirror ? 1 - p.x : p.x,
        y: p.y,
        z: p.z,
      }));

      // If slot was idle for >250ms, reset smoother so it snaps immediately to new hand
      const wasIdle = ts - slot.lastSeenMs > 250;
      if (wasIdle) {
        slot.smoother.reset();
        slot.prevFingerPos.clear();
      }

      const landmarks: Vec3[] = slot.smoother.smooth(raw, ts / 1000);
      slot.lastSeenMs = ts;
      slot.lastWrist = { x: landmarks[0].x, y: landmarks[0].y };

      const videoAspect =
        video.videoWidth > 0 && video.videoHeight > 0
          ? video.videoWidth / video.videoHeight
          : 16 / 9;

      const distAspect = (a: Vec3, b: Vec3) =>
        Math.hypot((a.x - b.x) * videoAspect, a.y - b.y);

      // Aspect-corrected palmSize so tilting the hand diagonally or horizontally on a 16:9 webcam
      // preserves its true physical closeness instead of shrinking by 1/1.77!
      const palmSize = Math.max(0.04, distAspect(landmarks[9], landmarks[0]));

      const palmCenter: Vec2 = {
        x: (landmarks[0].x + landmarks[5].x + landmarks[9].x + landmarks[13].x + landmarks[17].x) / 5,
        y: (landmarks[0].y + landmarks[5].y + landmarks[9].y + landmarks[13].y + landmarks[17].y) / 5,
      };

      // Pinch detection with isotropic aspect-corrected distance + hysteresis
      const thumbTip = landmarks[4];
      const indexTip = landmarks[8];
      const pinchRatio = distAspect(thumbTip, indexTip) / palmSize;

      if (slot.pinchActive) {
        if (pinchRatio > 0.39) slot.pinchActive = false;
      } else {
        if (pinchRatio < 0.29) slot.pinchActive = true;
      }

      const pinchPos: Vec2 = {
        x: (thumbTip.x + indexTip.x) * 0.5,
        y: (thumbTip.y + indexTip.y) * 0.5,
      };

      const palmSpeed = wasIdle
        ? 0
        : Math.hypot(palmCenter.x - slot.lastPalmCenter.x, palmCenter.y - slot.lastPalmCenter.y) /
          dtSec;
      slot.lastPalmCenter = palmCenter;

      const handednessLabel = res.handednesses?.[i]?.[0]?.categoryName;
      const handedness: 'Left' | 'Right' = handednessLabel === 'Left' ? 'Left' : 'Right';

      // Determine whether dorsal (back) of hand faces camera on RAW unmirrored landmarks
      const backFacing = isHandBackFacing(rawHands[i], handedness);

      // Determine extended fingertips (isotropic aspect-corrected)
      const extendedFingers = this.detectExtendedFingers(landmarks, palmSize, videoAspect);

      const fourExtended =
        extendedFingers.includes(8) &&
        extendedFingers.includes(12) &&
        extendedFingers.includes(16) &&
        extendedFingers.includes(20);

      // Forgiving open-hand posture for rapid close-up face-swipes: allows natural slight inward finger
      // curvature toward the face while still strictly rejecting fists, pinches, and 1-2 finger plucking!
      const wrist = landmarks[0];
      const uncurledMainCount = (
        [
          [8, 6],
          [12, 10],
          [16, 14],
          [20, 18],
        ] as [number, number][]
      ).filter(([tip, pip]) => distAspect(landmarks[tip], wrist) > distAspect(landmarks[pip], wrist) * 1.03)
        .length;
      const avgTipReach =
        (distAspect(landmarks[8], wrist) +
          distAspect(landmarks[12], wrist) +
          distAspect(landmarks[16], wrist) +
          distAspect(landmarks[20], wrist)) *
        0.25;
      const fiveFingersOpen = !slot.pinchActive && uncurledMainCount >= 4 && avgTipReach > palmSize * 1.42;

      // Open Palm Mute: all 4 main fingers extended, moving gently (stationary mute — disjoint from fast face swipe)
      const openPalm = !slot.pinchActive && fourExtended && palmSpeed < 0.36;

      // Suppress accidental string plucks while performing a fast close-up open-hand swipe across the face
      const isCloseSwipePosture = fiveFingersOpen && palmSize >= 0.125 && palmSpeed > 0.34;

      // Build active finger trajectories for segment-intersection plucking
      const activeFingers: ActiveFinger[] = [];
      for (const tipIdx of FINGERTIPS) {
        const pt: Vec2 = { x: landmarks[tipIdx].x, y: landmarks[tipIdx].y };
        const prev = slot.prevFingerPos.get(tipIdx) ?? pt;
        slot.prevFingerPos.set(tipIdx, pt);

        if (isCloseSwipePosture || !extendedFingers.includes(tipIdx)) continue;
        const speed = Math.hypot(pt.x - prev.x, pt.y - prev.y) / dtSec;
        activeFingers.push({
          id: `${slot.id}-${tipIdx}`,
          handId: slot.id,
          landmarkIndex: tipIdx,
          pos: pt,
          prevPos: prev,
          speed,
          isPrimary: tipIdx === 8,
        });
      }

      tracked.push({
        id: slot.id,
        handedness,
        landmarks,
        pinchActive: slot.pinchActive,
        pinchPos,
        palmCenter,
        palmSize,
        openPalm,
        backFacing,
        fiveFingersOpen,
        extendedFingers,
        activeFingers,
      });
    }

    return tracked;
  }

  /**
   * Runs selfie segmentation at ~22 Hz for portrait starfield & X-Ray modes.
   */
  detectSegmentation(video: HTMLVideoElement, nowMs: number): SegmentationFrame | null {
    if (!this.segmenter || video.readyState < 2) return null;
    if (nowMs - this.lastSegMs < 46 && this.segMaskBuffer) {
      return {
        data: this.segMaskBuffer,
        width: this.segWidth,
        height: this.segHeight,
      };
    }
    this.lastSegMs = nowMs;

    try {
      const result = this.segmenter.segmentForVideo(video, Math.max(nowMs, 1));
      const masks = result.confidenceMasks;
      if (!masks || masks.length === 0) return null;

      // Selfie segmenter outputs [background, person] or single person confidence mask
      const personMask = masks.length > 1 ? masks[1] : masks[0];
      const w = personMask.width;
      const h = personMask.height;
      const floats = personMask.getAsFloat32Array();
      const total = w * h;

      if (!this.segMaskBuffer || this.segMaskBuffer.length !== total) {
        this.segMaskBuffer = new Uint8Array(total);
        this.segWidth = w;
        this.segHeight = h;
      }

      // Temporal smoothing on mask buffer to eliminate flickering edges
      for (let i = 0; i < total; i++) {
        const target = Math.max(0, Math.min(255, Math.round(floats[i] * 255)));
        this.segMaskBuffer[i] = Math.round(this.segMaskBuffer[i] * 0.35 + target * 0.65);
      }

      result.close();
      return {
        data: this.segMaskBuffer,
        width: this.segWidth,
        height: this.segHeight,
      };
    } catch {
      return null;
    }
  }

  /**
   * Runs 33-point full-body PoseLandmarker once per unique camera frame for X-Ray skeleton mode.
   */
  detectPose(video: HTMLVideoElement, nowMs: number, mirror: boolean): TrackedPose | null {
    if (!this.poseLandmarker || video.readyState < 2 || video.videoWidth === 0) {
      return null;
    }
    if (video.currentTime === this.lastPoseVideoTime) {
      return this.cachedPose && nowMs - this.lastPoseSeenMs < 260 ? this.cachedPose : null;
    }
    this.lastPoseVideoTime = video.currentTime;

    const ts = Math.max(nowMs, this.lastPoseTimestampMs + 1);
    this.lastPoseTimestampMs = ts;

    try {
      const res = this.poseLandmarker.detectForVideo(video, ts);
      const rawPose = res.landmarks?.[0];
      if (!rawPose || rawPose.length < 25) {
        if (ts - this.lastPoseSeenMs > 260) {
          this.poseSmoother.reset();
          this.cachedPose = null;
        }
        return this.cachedPose;
      }

      if (ts - this.lastPoseSeenMs > 260) {
        this.poseSmoother.reset();
      }

      const rawVecs = rawPose.map((p) => ({
        x: mirror ? 1 - p.x : p.x,
        y: p.y,
        z: p.z,
      }));
      const smoothed = this.poseSmoother.smooth(rawVecs, ts / 1000);
      const landmarks: PoseLandmark[] = smoothed.map((pt, i) => ({
        x: pt.x,
        y: pt.y,
        z: pt.z,
        visibility: rawPose[i]?.visibility ?? 1,
      }));

      this.lastPoseSeenMs = ts;
      this.cachedPose = { landmarks, timestampMs: ts };
      return this.cachedPose;
    } catch {
      return this.cachedPose;
    }
  }

  /**
   * Runs 478-point FaceLandmarker + ARKit jaw/mouth blendshapes once per unique video frame
   * for hyper-realistic 3D X-Ray skull tracking & live jaw articulation.
   */
  detectFace(video: HTMLVideoElement, nowMs: number, mirror: boolean): TrackedFace | null {
    if (!this.faceLandmarker || video.readyState < 2 || video.videoWidth === 0) {
      return null;
    }
    if (video.currentTime === this.lastFaceVideoTime) {
      return this.cachedFace && nowMs - this.lastFaceSeenMs < 240 ? this.cachedFace : null;
    }
    this.lastFaceVideoTime = video.currentTime;

    const ts = Math.max(nowMs, this.lastFaceTimestampMs + 1);
    this.lastFaceTimestampMs = ts;

    try {
      const res = this.faceLandmarker.detectForVideo(video, ts);
      const raw = res.faceLandmarks?.[0];
      if (!raw || raw.length < 468) {
        if (ts - this.lastFaceSeenMs > 240) {
          this.resetFaceSmoothers();
          this.cachedFace = null;
        }
        return this.cachedFace;
      }

      if (ts - this.lastFaceSeenMs > 240) {
        this.resetFaceSmoothers();
      }

      const pick = (idx: number): Vec3 => {
        const p = raw[idx];
        return { x: mirror ? 1 - p.x : p.x, y: p.y, z: p.z };
      };
      const mid = (a: number, b: number): Vec3 => {
        const pa = pick(a);
        const pb = pick(b);
        return { x: (pa.x + pb.x) * 0.5, y: (pa.y + pb.y) * 0.5, z: (pa.z + pb.z) * 0.5 };
      };

      // Extract 11 anatomical key face anchors in mirrored video space
      const rawPts: Vec3[] = [
        pick(10),        // 0: forehead top
        pick(152),       // 1: chin bottom
        pick(234),       // 2: cheek A
        pick(454),       // 3: cheek B
        mid(33, 133),    // 4: eye A center
        mid(362, 263),   // 5: eye B center
        pick(1),         // 6: nose tip
        pick(13),        // 7: upper inner lip
        pick(14),        // 8: lower inner lip
        pick(61),        // 9: mouth corner A
        pick(291),       // 10: mouth corner B
      ];

      const tSec = ts / 1000;
      const sm = this.facePtSmoother.smooth(rawPts, tSec);

      // Canonical viewer-left / viewer-right ordering for symmetric cheekbones, eyes & mouth corners
      const cheekLeft = sm[2].x <= sm[3].x ? sm[2] : sm[3];
      const cheekRight = sm[2].x <= sm[3].x ? sm[3] : sm[2];
      const eyeLeft = sm[4].x <= sm[5].x ? sm[4] : sm[5];
      const eyeRight = sm[4].x <= sm[5].x ? sm[5] : sm[4];
      const mouthLeft = sm[9].x <= sm[10].x ? sm[9] : sm[10];
      const mouthRight = sm[9].x <= sm[10].x ? sm[10] : sm[9];

      // Read ARKit Blendshapes (jawOpen, jawLeft, jawRight, mouthStretch)
      let bsJawOpen = 0;
      let bsJawLeft = 0;
      let bsJawRight = 0;
      let bsMouthStretch = 0;
      const cats = res.faceBlendshapes?.[0]?.categories;
      if (cats) {
        for (const c of cats) {
          if (c.categoryName === 'jawOpen') bsJawOpen = c.score;
          else if (c.categoryName === 'jawLeft') bsJawLeft = c.score;
          else if (c.categoryName === 'jawRight') bsJawRight = c.score;
          else if (c.categoryName === 'mouthStretchLeft' || c.categoryName === 'mouthStretchRight') {
            bsMouthStretch = Math.max(bsMouthStretch, c.score);
          }
        }
      }

      // Fuse geometric lip aperture with ARKit jawOpen for crisp, unmistakable responsiveness
      const faceH = Math.max(0.05, Math.hypot(sm[1].x - sm[0].x, sm[1].y - sm[0].y));
      const lipGap = Math.hypot(sm[8].x - sm[7].x, sm[8].y - sm[7].y);
      const geomJawOpen = Math.max(0, Math.min(1, (lipGap / faceH - 0.015) / 0.22));
      const rawJawOpen = Math.max(bsJawOpen, geomJawOpen * 0.95);
      const rawJawShiftX = mirror ? bsJawRight - bsJawLeft : bsJawLeft - bsJawRight;

      // Extract 3D pitch & yaw from MediaPipe 4x4 face matrix; derive roll directly from smoothed eyes
      // so the 3D skull sockets always track the user's real eyes with zero axis-convention ambiguity.
      let rawPitch = 0;
      let rawYaw = 0;
      const rawRoll = Math.atan2(-(eyeRight.y - eyeLeft.y), eyeRight.x - eyeLeft.x);
      const mat = res.facialTransformationMatrixes?.[0]?.data;
      if (mat && mat.length >= 16) {
        // Column-major 4x4 rotation matrix R
        const r00 = mat[0], r10 = mat[1], r20 = mat[2];
        const r21 = mat[6], r22 = mat[10];
        const sy = Math.hypot(r00, r10);
        const mPitch = Math.atan2(r21, r22);
        const mYaw = Math.atan2(-r20, sy);
        rawPitch = mPitch;
        rawYaw = mirror ? -mYaw : mYaw;
      } else {
        const eyeMidX = (eyeLeft.x + eyeRight.x) * 0.5;
        const faceW = Math.max(0.05, Math.hypot(cheekRight.x - cheekLeft.x, cheekRight.y - cheekLeft.y));
        rawYaw = Math.max(-0.7, Math.min(0.7, ((sm[6].x - eyeMidX) / (faceW * 0.5)) * 0.85));
      }

      const f = this.faceScalarFilters;
      this.lastFaceSeenMs = ts;
      this.cachedFace = {
        foreheadTop: { x: sm[0].x, y: sm[0].y },
        chinBottom: { x: sm[1].x, y: sm[1].y },
        cheekLeft: { x: cheekLeft.x, y: cheekLeft.y },
        cheekRight: { x: cheekRight.x, y: cheekRight.y },
        eyeLeft: { x: eyeLeft.x, y: eyeLeft.y },
        eyeRight: { x: eyeRight.x, y: eyeRight.y },
        noseTip: { x: sm[6].x, y: sm[6].y },
        upperLipInner: { x: sm[7].x, y: sm[7].y },
        lowerLipInner: { x: sm[8].x, y: sm[8].y },
        mouthLeft: { x: mouthLeft.x, y: mouthLeft.y },
        mouthRight: { x: mouthRight.x, y: mouthRight.y },
        pitch: f.pitch.filter(rawPitch, tSec),
        yaw: f.yaw.filter(rawYaw, tSec),
        roll: f.roll.filter(rawRoll, tSec),
        jawOpen: Math.max(0, Math.min(1, f.jawOpen.filter(rawJawOpen, tSec))),
        jawShiftX: Math.max(-1, Math.min(1, f.jawShiftX.filter(rawJawShiftX, tSec))),
        mouthStretch: Math.max(0, Math.min(1, f.mouthStretch.filter(bsMouthStretch, tSec))),
        timestampMs: ts,
      };
      return this.cachedFace;
    } catch {
      return this.cachedFace;
    }
  }

  private resetFaceSmoothers(): void {
    this.facePtSmoother.reset();
    this.faceScalarFilters.pitch.reset();
    this.faceScalarFilters.yaw.reset();
    this.faceScalarFilters.roll.reset();
    this.faceScalarFilters.jawOpen.reset();
    this.faceScalarFilters.jawShiftX.reset();
    this.faceScalarFilters.mouthStretch.reset();
  }

  private assignSlots(
    rawHands: { x: number; y: number; z: number }[][],
    mirror: boolean,
    nowMs: number
  ): HandSlot[] {
    if (rawHands.length === 1) {
      const w = { x: mirror ? 1 - rawHands[0][0].x : rawHands[0][0].x, y: rawHands[0][0].y };
      const d0 =
        nowMs - this.slots[0].lastSeenMs < 400
          ? Math.hypot(w.x - this.slots[0].lastWrist.x, w.y - this.slots[0].lastWrist.y)
          : 10;
      const d1 =
        nowMs - this.slots[1].lastSeenMs < 400
          ? Math.hypot(w.x - this.slots[1].lastWrist.x, w.y - this.slots[1].lastWrist.y)
          : 10;
      return [d0 <= d1 ? this.slots[0] : this.slots[1]];
    }

    const w0 = { x: mirror ? 1 - rawHands[0][0].x : rawHands[0][0].x, y: rawHands[0][0].y };
    const w1 = { x: mirror ? 1 - rawHands[1][0].x : rawHands[1][0].x, y: rawHands[1][0].y };

    const costDirect =
      Math.hypot(w0.x - this.slots[0].lastWrist.x, w0.y - this.slots[0].lastWrist.y) +
      Math.hypot(w1.x - this.slots[1].lastWrist.x, w1.y - this.slots[1].lastWrist.y);
    const costSwap =
      Math.hypot(w0.x - this.slots[1].lastWrist.x, w0.y - this.slots[1].lastWrist.y) +
      Math.hypot(w1.x - this.slots[0].lastWrist.x, w1.y - this.slots[0].lastWrist.y);

    return costDirect <= costSwap ? [this.slots[0], this.slots[1]] : [this.slots[1], this.slots[0]];
  }

  private detectExtendedFingers(lm: Vec3[], palmSize: number, videoAspect = 16 / 9): number[] {
    const extended: number[] = [];
    const wrist = lm[0];
    const d = (a: Vec3, b: Vec3) => Math.hypot((a.x - b.x) * videoAspect, a.y - b.y);

    // Thumb: tip (4) extended away from index MCP (5) and pinky MCP (17)
    if (d(lm[4], lm[5]) > palmSize * 0.44 && d(lm[4], lm[17]) > d(lm[2], lm[17]) * 1.06) {
      extended.push(4);
    }

    // Index, Middle, Ring, Pinky: tip farther from wrist than PIP joint by clear margin
    const fingerTriples: [number, number][] = [
      [8, 6],
      [12, 10],
      [16, 14],
      [20, 18],
    ];
    for (const [tip, pip] of fingerTriples) {
      if (d(lm[tip], wrist) > d(lm[pip], wrist) * 1.13) {
        extended.push(tip);
      }
    }

    return extended;
  }

  dispose(): void {
    this.handLandmarker?.close();
    this.segmenter?.close();
    this.poseLandmarker?.close();
    this.faceLandmarker?.close();
    this.handLandmarker = null;
    this.segmenter = null;
    this.poseLandmarker = null;
    this.faceLandmarker = null;
  }
}
