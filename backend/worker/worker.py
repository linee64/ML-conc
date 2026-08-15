"""
worker.py — BullMQ-like worker, слушает Redis очередь 'ml-tasks'
и обрабатывает кадры через process_frame.py.

Для MVP используем простой polling Redis через rpop.
"""

import os
import sys
import json
import time
import subprocess
import redis

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
QUEUE_NAME = "bull:ml-tasks:wait"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROCESS_SCRIPT = os.path.join(SCRIPT_DIR, "process_frame.py")


def get_redis_client():
    return redis.Redis.from_url(REDIS_URL, decode_responses=True)


def process_job(job_data: dict) -> dict:
    """Вызываем process_frame.py как subprocess."""
    file_path = job_data.get("filePath", "")
    if not file_path or not os.path.isfile(file_path):
        return {"score": 0, "event": "error", "details": f"File not found: {file_path}"}

    try:
        result = subprocess.run(
            [sys.executable, PROCESS_SCRIPT, file_path],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return {"score": 0, "event": "error", "details": result.stderr[:500]}
        return json.loads(result.stdout)
    except Exception as e:
        return {"score": 0, "event": "error", "details": str(e)}


def main():
    print("🐍 ML Worker started, connecting to Redis...")
    r = get_redis_client()
    r.ping()
    print(f"✅ Connected to Redis. Listening on queue '{QUEUE_NAME}'...")

    while True:
        # BullMQ хранит задачи в нескольких ключах;
        # для MVP мы слушаем простой список
        job_raw = r.rpop(QUEUE_NAME)
        if job_raw is None:
            time.sleep(0.2)  # polling interval
            continue

        try:
            job_id = job_raw  # BullMQ кладёт ID задачи
            job_key = f"bull:ml-tasks:{job_id}"
            job_data_raw = r.hget(job_key, "data")
            if job_data_raw:
                job_data = json.loads(job_data_raw)
            else:
                job_data = {}

            print(f"👷 Processing job {job_id}: {job_data}")
            result = process_job(job_data)
            print(f"✅ Job {job_id} result: {result}")

            # Сохраняем результат обратно в Redis для API
            r.hset(job_key, "returnvalue", json.dumps(result))
            r.hset(job_key, "processedOn", str(int(time.time() * 1000)))
            r.hset(job_key, "finishedOn", str(int(time.time() * 1000)))

            # Публикуем результат через Redis Pub/Sub для Socket.io
            r.publish("ml-results", json.dumps({"jobId": job_id, **result}))

        except Exception as e:
            print(f"❌ Error processing job: {e}")

    print("Worker stopped.")


if __name__ == "__main__":
    main()
