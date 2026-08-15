import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { Worker, Job } from 'bullmq';
import multer from 'multer';
import dotenv from 'dotenv';
import cors from 'cors';
import Redis from 'ioredis';
import { mlQueue } from './queue';
import prisma from './prisma';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const PORT = process.env.PORT || 5000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ─── Express App ─────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health Check ────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Active session tracking (single user MVP)
let activeSessionId: number | null = null;
let isDbAvailable = true;

// ─── Session API ─────────────────────────────────────────
app.post('/api/session/start', async (_req: Request, res: Response) => {
  try {
    if (isDbAvailable) {
      try {
        let user = await prisma.user.findFirst();
        if (!user) {
          user = await prisma.user.create({
            data: { email: 'user@focuscoach.local' },
          });
        }

        const session = await prisma.session.create({
          data: {
            userId: user.id,
            startTime: new Date(),
          },
        });

        activeSessionId = session.id;
        console.log(`🎬 Session #${session.id} started for User #${user.id}`);
        return res.json({ success: true, session });
      } catch (dbErr: any) {
        console.warn('⚠️ Postgres unavailable, running session in memory mode:', dbErr.message);
        isDbAvailable = false;
      }
    }

    // In-memory fallback session
    activeSessionId = Date.now();
    console.log(`🎬 In-Memory Session #${activeSessionId} started`);
    return res.json({
      success: true,
      session: { id: activeSessionId, startTime: new Date(), mode: 'in_memory' },
    });
  } catch (err: any) {
    console.error('Failed to start session:', err);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

app.post('/api/session/stop', async (_req: Request, res: Response) => {
  try {
    if (!activeSessionId) {
      return res.json({ success: true, message: 'No active session' });
    }

    if (isDbAvailable) {
      try {
        const session = await prisma.session.update({
          where: { id: activeSessionId },
          data: { endTime: new Date() },
        });
        console.log(`🛑 Session #${activeSessionId} stopped`);
        activeSessionId = null;
        return res.json({ success: true, session });
      } catch (dbErr: any) {
        isDbAvailable = false;
      }
    }

    console.log(`🛑 In-Memory Session #${activeSessionId} stopped`);
    activeSessionId = null;
    return res.json({ success: true, message: 'Session stopped (in-memory)' });
  } catch (err: any) {
    console.error('Failed to stop session:', err);
    res.status(500).json({ error: 'Failed to stop session' });
  }
});

// ─── Frame Upload API ────────────────────────────────────
const upload = multer({ dest: uploadsDir });

app.post('/api/frame', upload.single('frame'), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const filePath = req.file.path;

  // Promise with fast timeout for Queue addition
  const enqueuePromise = Promise.race([
    mlQueue.add('process', { filePath, sessionId: activeSessionId }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Queue timeout')), 200)),
  ]);

  try {
    const job: any = await enqueuePromise;
    return res.json({ jobId: job.id, status: 'enqueued' });
  } catch (qErr: any) {
    // Fast failover for standalone local mode
    const mockScore = Math.floor(Math.random() * 25) + 75;
    const mockResult = {
      score: mockScore,
      event: mockScore < 50 ? 'distraction' : null,
      details: { mode: 'standalone_local', frame: path.basename(filePath) },
    };

    io.emit('ml-result', mockResult);
    return res.json({ status: 'processed_direct', result: mockResult });
  }
});

// ─── HTTP + Socket.io ────────────────────────────────────
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

io.on('connection', (socket) => {
  console.log('🟢 Client connected:', socket.id);
  socket.on('disconnect', () => console.log('🔴 Client disconnected:', socket.id));
});

// ─── Redis Sub for ML Worker Results ──────────────────────
try {
  const subRedis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  subRedis.on('error', () => {});
  subRedis
    .connect()
    .then(() => {
      console.log('📡 Subscribed to Redis channel: ml-results');
      subRedis.subscribe('ml-results');
      subRedis.on('message', async (channel, message) => {
        if (channel === 'ml-results') {
          try {
            const data = JSON.parse(message);
            console.log('⚡ ML Result via Redis:', data);
            io.emit('ml-result', data);

            if (activeSessionId && isDbAvailable) {
              await prisma.frame.create({
                data: {
                  sessionId: activeSessionId,
                  imagePath: data.filePath || '',
                  score: data.score ?? 100,
                  event: data.event || null,
                },
              });
              if (data.event) {
                await prisma.event.create({
                  data: {
                    sessionId: activeSessionId,
                    type: data.event,
                    details: JSON.stringify(data.details || {}),
                  },
                });
              }
            }
          } catch (e) {
            console.error('Error handling redis message:', e);
          }
        }
      });
    })
    .catch((err) => {
      console.warn('⚠️ Redis subscriber offline (standalone mode):', err.message);
    });
} catch (e) {
  console.warn('Redis pub/sub setup skipped:', e);
}

// ─── BullMQ Worker (Node Fallback Worker) ───────────────
try {
  const worker = new Worker(
    'ml-tasks',
    async (job: Job) => {
      console.log('👷 Node Worker processing job:', job.id, job.data);
      const result = {
        jobId: job.id,
        score: Math.floor(Math.random() * 30) + 70,
        event: null,
        details: { mode: 'fallback_node' },
      };
      return result;
    },
    { connection: { url: redisUrl } }
  );

  worker.on('completed', (job) => {
    console.log('✅ Node Worker completed job:', job.id);
    io.emit('ml-result', job.returnvalue);
  });

  worker.on('failed', (job, err) => {
    console.error('❌ Job failed:', job?.id, err);
  });
} catch (wErr) {
  console.warn('BullMQ Worker skipped (Redis offline):', wErr);
}

// ─── Start Server ────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`🚀 API server listening on http://localhost:${PORT}`);
});
