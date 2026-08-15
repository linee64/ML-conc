import { Queue } from 'bullmq';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const mlQueue = new Queue('ml-tasks', {
  connection: { url: redisUrl },
});
