import cron from 'node-cron';
import { InstanceStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { dockerService } from './docker.service';

async function runCleanup(): Promise<void> {
  const now = new Date();

  const expiredInstances = await prisma.instance.findMany({
    where: {
      status: { in: [InstanceStatus.PROVISIONING, InstanceStatus.RUNNING] },
      expiresAt: { lte: now },
    },
    select: {
      id: true,
      containerId: true,
      containerName: true,
      subdomain: true,
    },
  });

  if (expiredInstances.length === 0) {
    return;
  }

  console.log(`[CleanupWorker] Found ${expiredInstances.length} expired instance(s) to clean up.`);

  const results = await Promise.allSettled(
    expiredInstances.map(async (instance) => {
      try {
        if (instance.containerId) {
          await dockerService.destroyInstance(instance.containerId);
          console.log(
            `[CleanupWorker] Destroyed container ${instance.containerId} for instance ${instance.id}`,
          );
        } else {
          console.warn(
            `[CleanupWorker] Instance ${instance.id} has no containerId, skipping Docker destroy.`,
          );
        }

        await prisma.instance.update({
          where: { id: instance.id },
          data: {
            status: InstanceStatus.EXPIRED,
            stoppedAt: now,
          },
        });

        console.log(`[CleanupWorker] Marked instance ${instance.id} as EXPIRED.`);
      } catch (err) {
        console.error(`[CleanupWorker] Failed to clean up instance ${instance.id}:`, err);
        // Update status to FAILED so it won't be retried indefinitely
        await prisma.instance
          .update({
            where: { id: instance.id },
            data: { status: InstanceStatus.FAILED, stoppedAt: now },
          })
          .catch((updateErr) =>
            console.error(
              `[CleanupWorker] Also failed to mark instance ${instance.id} as FAILED:`,
              updateErr,
            ),
          );
        throw err;
      }
    }),
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;
  console.log(`[CleanupWorker] Cleanup complete. Succeeded: ${succeeded}, Failed: ${failed}`);
}

export function startCleanupWorker(): void {
  console.log('[CleanupWorker] Starting cleanup worker (runs every minute).');

  // Run once immediately on startup
  runCleanup().catch((err) => console.error('[CleanupWorker] Initial cleanup run failed:', err));

  // Schedule to run every minute
  cron.schedule('* * * * *', () => {
    runCleanup().catch((err) => console.error('[CleanupWorker] Scheduled cleanup run failed:', err));
  });
}
