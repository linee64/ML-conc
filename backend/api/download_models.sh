#!/usr/bin/env bash
# download_models.sh – скачивает необходимые модели в каталог ./models
set -e

MODEL_DIR=$(dirname "$0")/models
mkdir -p "$MODEL_DIR"

# Пример: скачиваем MediaPipe Face Mesh модель (примерный URL, замените на актуальный)
curl -L -o "$MODEL_DIR/face_mesh.tflite" "https://storage.googleapis.com/mediapipe-models/face_mesh/blaze_face_front.tflite"

echo "✅ Models downloaded to $MODEL_DIR"
