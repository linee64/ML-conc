// src/FocusCamera.tsx
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

export interface MLResult {
  jobId?: string;
  score: number;
  event: string | null;
  details?: {
    gaze_ratio?: number;
    gaze_direction?: string;
    head_tilt_deg?: number;
    head_pose?: string;
    eye_state?: string;
    mouth_state?: string;
    face_detected?: boolean;
    reason?: string;
    mode?: string;
    [key: string]: any;
  };
}

interface FocusCameraProps {
  onResult?: (result: MLResult) => void;
  onConnectionChange?: (connected: boolean) => void;
  backendUrl?: string;
}

/**
 * Multi-Factor FocusCamera Engine with Real-Time MediaPipe WASM:
 * 1. Eye Gaze Direction (Left, Right, Up, Down / Phone)
 * 2. Head Yaw (Turn Left / Right) & Roll (Tilt) & Pitch (Looking down)
 * 3. Drowsiness / Closed Eyes (EAR + Blendshapes)
 * 4. Yawning / Open Mouth (MAR + Blendshapes)
 * 5. Face Presence / Leaving seat
 */
const FocusCamera: React.FC<FocusCameraProps> = ({
  onResult,
  onConnectionChange,
  backendUrl = 'http://localhost:5000',
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const animFrameIdRef = useRef<number | null>(null);
  const lastUploadTimeRef = useRef<number>(0);
  const isUploadingRef = useRef<boolean>(false);
  const closedEyeFramesRef = useRef<number>(0);

  const [latestResult, setLatestResult] = useState<MLResult | null>(null);
  const [cameraActive, setCameraActive] = useState<boolean>(false);
  const [modelLoaded, setModelLoaded] = useState<boolean>(false);

  // ── 1. Connect Socket.io ─────────────────────────────────
  useEffect(() => {
    const socket = io(backendUrl, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      onConnectionChange?.(true);
    });

    socket.on('disconnect', () => {
      onConnectionChange?.(false);
    });

    socket.on('ml-result', (data: MLResult) => {
      setLatestResult(data);
      onResult?.(data);
    });

    return () => {
      socket.disconnect();
    };
  }, [backendUrl, onResult, onConnectionChange]);

  // ── 2. Load MediaPipe Face Landmarker (WASM) ─────────────
  useEffect(() => {
    let isCancelled = false;

    const initMediaPipe = async () => {
      try {
        const filesetResolver = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        );
        const faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
            delegate: 'GPU',
          },
          outputFaceBlendshapes: true,
          runningMode: 'VIDEO',
          numFaces: 1,
        });

        if (!isCancelled) {
          landmarkerRef.current = faceLandmarker;
          setModelLoaded(true);
          console.log('✅ MediaPipe Multi-Factor FaceLandmarker loaded (GPU)');
        }
      } catch (err) {
        console.warn('⚠️ MediaPipe GPU failed, falling back to CPU:', err);
        try {
          const filesetResolver = await FilesetResolver.forVisionTasks(
            'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
          );
          const faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
            baseOptions: {
              modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
              delegate: 'CPU',
            },
            outputFaceBlendshapes: true,
            runningMode: 'VIDEO',
            numFaces: 1,
          });
          if (!isCancelled) {
            landmarkerRef.current = faceLandmarker;
            setModelLoaded(true);
          }
        } catch (cpuErr) {
          console.error('Failed to load MediaPipe:', cpuErr);
        }
      }
    };

    initMediaPipe();

    return () => {
      isCancelled = true;
      if (landmarkerRef.current) {
        landmarkerRef.current.close();
      }
    };
  }, []);

  // ── 3. Start Webcam ──────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    navigator.mediaDevices
      .getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } })
      .then((stream) => {
        video.srcObject = stream;
        video.addEventListener('loadeddata', () => {
          video.play();
          setCameraActive(true);
        });
      })
      .catch((err) => {
        console.error('Webcam error:', err);
        setCameraActive(false);
      });

    return () => {
      const stream = video.srcObject as MediaStream | null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Helper to extract blendshape value
  const getBlendshapeValue = (blendshapes: any[], name: string): number => {
    if (!blendshapes || blendshapes.length === 0) return 0;
    const item = blendshapes[0].categories.find((c: any) => c.categoryName === name);
    return item ? item.score : 0;
  };

  // ── 4. Main Render & Multi-Factor ML Loop (60 FPS) ──────
  const processLoop = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (video && canvas && video.readyState >= 2) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;

        // Draw video frame smoothly
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        let currentScore = 100;
        let event: string | null = null;
        let reasons: string[] = [];
        let gazeRatio = 0.5;
        let headTiltDeg = 0;
        let faceDetected = false;
        let gazeDirection = 'Прямо';
        let headPose = 'Центр';
        let eyeState = 'Открыты';
        let mouthState = 'Норма';

        if (landmarkerRef.current && video.currentTime > 0) {
          try {
            const results = landmarkerRef.current.detectForVideo(video, performance.now());
            const blendshapes = results?.faceBlendshapes || [];

            if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
              faceDetected = true;
              const lm = results.faceLandmarks[0];

              // Key landmarks
              const nose = lm[1];
              const leftCheek = lm[234];
              const rightCheek = lm[454];
              const leftEyeOuter = lm[33];
              const rightEyeOuter = lm[263];

              // ── A. Head Roll (Tilt) ────────────────────────
              const dx = rightEyeOuter.x - leftEyeOuter.x;
              const dy = rightEyeOuter.y - leftEyeOuter.y;
              const rollRad = Math.atan2(dy, dx);
              headTiltDeg = Math.abs(Math.round((rollRad * 180) / Math.PI));

              // ── B. Head Yaw (Turn Left / Right) ───────────
              const distToLeftCheek = Math.hypot(nose.x - leftCheek.x, nose.y - leftCheek.y);
              const distToRightCheek = Math.hypot(nose.x - rightCheek.x, nose.y - rightCheek.y);
              const yawRatio = distToLeftCheek / (distToRightCheek || 0.001);

              if (yawRatio < 0.45) {
                headPose = 'Поворот влево';
                currentScore -= 40;
                reasons.push('Поворот головы влево');
              } else if (yawRatio > 2.2) {
                headPose = 'Поворот вправо';
                currentScore -= 40;
                reasons.push('Поворот головы вправо');
              } else if (headTiltDeg > 22) {
                headPose = `Наклон (${headTiltDeg}°)`;
                currentScore -= 30;
                reasons.push('Наклон головы');
              }

              // ── C. Eye Gaze Direction (Iris & Blendshapes) ──
              const eyeLookOutLeft = getBlendshapeValue(blendshapes, 'eyeLookOutLeft');
              const eyeLookInLeft = getBlendshapeValue(blendshapes, 'eyeLookInLeft');
              const eyeLookOutRight = getBlendshapeValue(blendshapes, 'eyeLookOutRight');
              const eyeLookInRight = getBlendshapeValue(blendshapes, 'eyeLookInRight');
              const eyeLookDownLeft = getBlendshapeValue(blendshapes, 'eyeLookDownLeft');
              const eyeLookDownRight = getBlendshapeValue(blendshapes, 'eyeLookDownRight');
              const eyeLookUpLeft = getBlendshapeValue(blendshapes, 'eyeLookUpLeft');
              const eyeLookUpRight = getBlendshapeValue(blendshapes, 'eyeLookUpRight');

              const horizontalDeviation = Math.abs(nose.x - 0.5);
              gazeRatio = Math.round((nose.x - ((lm[133].x + lm[362].x) / 2) + 0.5) * 100) / 100;

              // Gaze classification
              if (eyeLookDownLeft > 0.4 || eyeLookDownRight > 0.4) {
                gazeDirection = 'Вниз (телефон)';
                currentScore -= 45;
                reasons.push('Взгляд вниз (телефон / экран)');
              } else if (eyeLookOutLeft > 0.35 || eyeLookInRight > 0.35) {
                gazeDirection = 'Влево';
                currentScore -= 40;
                reasons.push('Взгляд в сторону (влево)');
              } else if (eyeLookOutRight > 0.35 || eyeLookInLeft > 0.35) {
                gazeDirection = 'Вправо';
                currentScore -= 40;
                reasons.push('Взгляд в сторону (вправо)');
              } else if (eyeLookUpLeft > 0.35 || eyeLookUpRight > 0.35) {
                gazeDirection = 'Вверх';
                currentScore -= 35;
                reasons.push('Взгляд вверх');
              } else if (horizontalDeviation > 0.17) {
                gazeDirection = 'В сторону';
                currentScore -= 35;
                reasons.push('Взгляд отведён от экрана');
              }

              // ── D. Drowsiness / Eye Closure ────────────────
              const eyeBlinkLeft = getBlendshapeValue(blendshapes, 'eyeBlinkLeft');
              const eyeBlinkRight = getBlendshapeValue(blendshapes, 'eyeBlinkRight');

              if (eyeBlinkLeft > 0.65 && eyeBlinkRight > 0.65) {
                closedEyeFramesRef.current += 1;
              } else {
                closedEyeFramesRef.current = 0;
              }

              // If eyes closed for > 8 frames (~150ms+)
              if (closedEyeFramesRef.current > 8) {
                eyeState = 'Закрыты / Сонливость';
                currentScore -= 50;
                reasons.push('Сонливость / Закрыты глаза');
              }

              // ── E. Yawning / Open Mouth ────────────────────
              const jawOpen = getBlendshapeValue(blendshapes, 'jawOpen');
              if (jawOpen > 0.45) {
                mouthState = 'Зевота';
                currentScore -= 25;
                reasons.push('Зевота / Усталость');
              }

              // ── F. Visual Landmarks & Gaze Overlay ─────────
              const strokeColor = currentScore < 55 ? '#ef4444' : currentScore < 75 ? '#f59e0b' : '#10b981';
              ctx.strokeStyle = strokeColor;
              ctx.lineWidth = 2;

              // Draw Eye Contour points
              ctx.fillStyle = strokeColor;
              for (let i = 0; i < lm.length; i += 6) {
                const pt = lm[i];
                ctx.beginPath();
                ctx.arc(pt.x * canvas.width, pt.y * canvas.height, 1.5, 0, 2 * Math.PI);
                ctx.fill();
              }

              // Draw Gaze Vector Line from Nose
              ctx.beginPath();
              ctx.moveTo(nose.x * canvas.width, nose.y * canvas.height);
              let gazeDx = 0;
              let gazeDy = 0;

              if (gazeDirection.includes('Влево')) gazeDx = -50;
              if (gazeDirection.includes('Вправо')) gazeDx = 50;
              if (gazeDirection.includes('Вниз')) gazeDy = 50;
              if (gazeDirection.includes('Вверх')) gazeDy = -50;

              ctx.lineTo(
                nose.x * canvas.width + gazeDx,
                nose.y * canvas.height + gazeDy
              );
              ctx.stroke();

            } else {
              // ── Face Missing ─────────────────────────────
              faceDetected = false;
              currentScore = 10;
              reasons.push('Лицо не в кадре / Отсутствие');
            }
          } catch (e) {
            // Guard loop error
          }
        }

        currentScore = Math.max(0, Math.min(100, currentScore));
        if (currentScore < 60) {
          event = 'distraction';
        }

        const primaryReason = reasons.length > 0 ? reasons.join('; ') : 'Внимание удержано';

        const computedResult: MLResult = {
          score: currentScore,
          event,
          details: {
            gaze_ratio: gazeRatio,
            gaze_direction: gazeDirection,
            head_tilt_deg: headTiltDeg,
            head_pose: headPose,
            eye_state: eyeState,
            mouth_state: mouthState,
            face_detected: faceDetected,
            reason: primaryReason,
            mode: 'Multi-Factor MediaPipe Engine',
          },
        };

        // Instant 0ms update to React UI
        onResult?.(computedResult);
        setLatestResult(computedResult);

        // ── Throttled Backend Sync (every 800ms) ─────────────
        const now = performance.now();
        if (now - lastUploadTimeRef.current > 800 && !isUploadingRef.current) {
          lastUploadTimeRef.current = now;
          isUploadingRef.current = true;

          canvas.toBlob(
            (blob) => {
              if (blob) {
                const formData = new FormData();
                formData.append('frame', blob, 'frame.jpg');
                formData.append('score', String(currentScore));
                formData.append('event', event || '');
                formData.append('reason', primaryReason);

                fetch(`${backendUrl}/api/frame`, {
                  method: 'POST',
                  body: formData,
                })
                  .catch(() => {})
                  .finally(() => {
                    isUploadingRef.current = false;
                  });
              } else {
                isUploadingRef.current = false;
              }
            },
            'image/jpeg',
            0.6
          );
        }
      }
    }

    animFrameIdRef.current = requestAnimationFrame(processLoop);
  }, [backendUrl, onResult]);

  // Start Loop
  useEffect(() => {
    animFrameIdRef.current = requestAnimationFrame(processLoop);
    return () => {
      if (animFrameIdRef.current) {
        cancelAnimationFrame(animFrameIdRef.current);
      }
    };
  }, [processLoop]);

  return (
    <div className="camera-container">
      <video ref={videoRef} style={{ display: 'none' }} playsInline muted />
      <div className="canvas-wrapper">
        <canvas ref={canvasRef} className="camera-canvas" />

        {!cameraActive && (
          <div className="camera-placeholder">
            <p>📷 Подключение к веб-камере...</p>
            <span>Пожалуйста, разрешите доступ к камере.</span>
          </div>
        )}

        {!modelLoaded && cameraActive && (
          <div className="model-loading-overlay">
            <span>⚡ Загрузка нейросети MediaPipe...</span>
          </div>
        )}

        {latestResult && (
          <div
            className={`live-score-overlay ${
              latestResult.score < 50 ? 'danger' : latestResult.score < 75 ? 'warning' : 'good'
            }`}
          >
            <div className="score-badge">
              <span className="score-val">{latestResult.score}</span>
              <span className="score-lbl">Score</span>
            </div>
            {latestResult.event && (
              <div className="event-badge">
                ⚠️ {latestResult.details?.reason || 'ОТВЛЕЧЕНИЕ'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default FocusCamera;
