import express from 'express';
import cors from 'cors';
import { config } from './config';
import { prisma } from './lib/prisma';
import { startCleanupWorker } from './services/cleanup.worker';
import userRoutes from './routes/user.routes';
import instanceRoutes from './routes/instance.routes';
import adminRoutes from './routes/admin.routes';
import challengeRoutes from './routes/challenge.routes';

const app = express();

// CORS
app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

// Body parsers
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check (no auth)
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'core-backend', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/users', userRoutes);
app.use('/api/instances', instanceRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/challenges', challengeRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Express] Unhandled error:', err);
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: message });
});

async function seedDatabase(): Promise<void> {
  try {
    await prisma.challenge.upsert({
      where: { slug: 'juice-shop' },
      create: {
        slug: 'juice-shop',
        name: 'OWASP Juice Shop',
        description:
          'OWASP Juice Shop is probably the most modern and sophisticated insecure web application. ' +
          'It can be used in security trainings, awareness demos, CTFs and as a guinea pig for security tools. ' +
          'It encompasses vulnerabilities from the entire OWASP Top Ten along with many other security flaws found in real-world applications.',
        category: 'Web Security',
        difficulty: 'Medium',
        points: 500,
        dockerImage: 'bkimminich/juice-shop:v16.0.0',
        internalPort: 3000,
      },
      update: {
        name: 'OWASP Juice Shop',
        description:
          'OWASP Juice Shop is probably the most modern and sophisticated insecure web application. ' +
          'It can be used in security trainings, awareness demos, CTFs and as a guinea pig for security tools. ' +
          'It encompasses vulnerabilities from the entire OWASP Top Ten along with many other security flaws found in real-world applications.',
        dockerImage: 'bkimminich/juice-shop:v16.0.0',
        internalPort: 3000,
      },
    });
    console.log('[Seed] Juice Shop challenge seeded successfully.');
  } catch (err) {
    console.error('[Seed] Failed to seed database:', err);
  }
}

async function main(): Promise<void> {
  // Seed DB
  await seedDatabase();

  // Start cleanup worker
  startCleanupWorker();

  // Start server
  const server = app.listen(config.port, () => {
    console.log(
      `[Server] Core Backend running on port ${config.port} in ${config.nodeEnv} mode`,
    );
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[Server] Received ${signal}. Shutting down gracefully...`);
    server.close(async () => {
      try {
        await prisma.$disconnect();
        console.log('[Server] Database connection closed. Exiting.');
        process.exit(0);
      } catch (err) {
        console.error('[Server] Error during shutdown:', err);
        process.exit(1);
      }
    });

    // Force exit after 15 seconds
    setTimeout(() => {
      console.error('[Server] Forced shutdown after timeout.');
      process.exit(1);
    }, 15_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
