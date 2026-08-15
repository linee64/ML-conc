"""
process_frame.py — обрабатывает один кадр через MediaPipe.

Вход:  путь к файлу изображения (argv[1])
Выход: JSON в stdout с полями score, event, details
"""

import sys
import json
import cv2
import numpy as np
import mediapipe as mp

# ─── MediaPipe инициализация ──────────────────────────────
mp_face_mesh = mp.solutions.face_mesh
mp_pose = mp.solutions.pose

# Индексы ирисов (MediaPipe FaceMesh 468+ landmarks)
LEFT_IRIS = [474, 475, 476, 477]
RIGHT_IRIS = [469, 470, 471, 472]
LEFT_EYE_OUTER = 33
LEFT_EYE_INNER = 133
RIGHT_EYE_OUTER = 263
RIGHT_EYE_INNER = 362


def compute_gaze_ratio(landmarks, eye_outer_idx: int, eye_inner_idx: int, iris_indices: list) -> float:
    """
    Возвращает число 0..1, показывающее, насколько ирис смещён
    к внешнему углу глаза (0 = смотрит внутрь, 1 = смотрит наружу).
    """
    outer = np.array([landmarks[eye_outer_idx].x, landmarks[eye_outer_idx].y])
    inner = np.array([landmarks[eye_inner_idx].x, landmarks[eye_inner_idx].y])
    iris_center = np.mean(
        [[landmarks[i].x, landmarks[i].y] for i in iris_indices], axis=0,
    )
    eye_width = np.linalg.norm(outer - inner)
    if eye_width < 1e-6:
        return 0.5
    return float(np.linalg.norm(iris_center - inner) / eye_width)


def compute_head_tilt(pose_landmarks) -> float:
    """
    Возвращает угол наклона головы (в градусах) по ключевым
    точкам плеч и носа. Большой наклон = отвлечение.
    """
    nose = pose_landmarks[mp_pose.PoseLandmark.NOSE.value]
    left_shoulder = pose_landmarks[mp_pose.PoseLandmark.LEFT_SHOULDER.value]
    right_shoulder = pose_landmarks[mp_pose.PoseLandmark.RIGHT_SHOULDER.value]
    shoulder_mid = np.array([
        (left_shoulder.x + right_shoulder.x) / 2,
        (left_shoulder.y + right_shoulder.y) / 2,
    ])
    nose_pt = np.array([nose.x, nose.y])
    diff = nose_pt - shoulder_mid
    angle = float(np.degrees(np.arctan2(abs(diff[0]), abs(diff[1]) + 1e-6)))
    return angle


def process(image_path: str) -> dict:
    img = cv2.imread(image_path)
    if img is None:
        return {"score": 0, "event": "error", "details": "Cannot read image"}

    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    h, w, _ = img.shape

    score = 100  # начинаем с максимальной концентрации
    event = None
    details = {}

    # ── Face Mesh (gaze) ──────────────────────────────────
    with mp_face_mesh.FaceMesh(
        max_num_faces=1,
        refine_landmarks=True,  # нужно для ирисов
        min_detection_confidence=0.5,
    ) as face_mesh:
        result = face_mesh.process(rgb)
        if result.multi_face_landmarks:
            lm = result.multi_face_landmarks[0].landmark
            left_ratio = compute_gaze_ratio(lm, LEFT_EYE_OUTER, LEFT_EYE_INNER, LEFT_IRIS)
            right_ratio = compute_gaze_ratio(lm, RIGHT_EYE_OUTER, RIGHT_EYE_INNER, RIGHT_IRIS)
            avg_ratio = (left_ratio + right_ratio) / 2
            details["gaze_ratio"] = round(avg_ratio, 3)

            # Если взгляд сильно смещён от центра (0.5) — штраф
            gaze_deviation = abs(avg_ratio - 0.5) * 2  # 0..1
            score -= int(gaze_deviation * 40)
        else:
            # Лицо не обнаружено — большой штраф
            score -= 50
            details["face_detected"] = False

    # ── Pose (head tilt) ──────────────────────────────────
    with mp_pose.Pose(
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    ) as pose:
        result = pose.process(rgb)
        if result.pose_landmarks:
            tilt = compute_head_tilt(result.pose_landmarks.landmark)
            details["head_tilt_deg"] = round(tilt, 1)
            if tilt > 25:
                score -= 30
        else:
            details["pose_detected"] = False
            score -= 20

    # ── Итоговый score ────────────────────────────────────
    score = max(0, min(100, score))
    if score < 50:
        event = "distraction"

    return {"score": score, "event": event, "details": details}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"score": 0, "event": "error", "details": "No image path provided"}))
        sys.exit(1)

    result = process(sys.argv[1])
    print(json.dumps(result))
