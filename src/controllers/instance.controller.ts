import { Request, Response } from 'express';
import { InstanceStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { dockerService } from '../services/docker.service';
import { config } from '../config';

const ACTIVE_STATUSES: InstanceStatus[] = [InstanceStatus.PROVISIONING, InstanceStatus.RUNNING];

export const getMyInstance = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const instance = await prisma.instance.findFirst({
      where: {
        userId: req.user.id,
        status: { in: ACTIVE_STATUSES },
      },
      include: {
        challenge: {
          select: { id: true, slug: true, name: true, category: true, difficulty: true, points: true },
        },
      },
    });

    if (!instance) {
      res.status(200).json({ instance: null });
      return;
    }

    let stats = null;
    if (instance.status === InstanceStatus.RUNNING && instance.containerId) {
      stats = await dockerService.getContainerStats(instance.containerId);
    }

    res.status(200).json({ instance, stats });
  } catch (err) {
    console.error('[InstanceController] getMyInstance error:', err);
    res.status(500).json({ error: 'Failed to retrieve instance' });
  }
};

export const startMyInstance = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { challengeId } = req.body as { challengeId?: string };

  if (!challengeId) {
    res.status(400).json({ error: 'Missing required field: challengeId' });
    return;
  }

  try {
    // Check for an existing active instance
    const existing = await prisma.instance.findFirst({
      where: {
        userId: req.user.id,
        status: { in: ACTIVE_STATUSES },
      },
    });

    if (existing) {
      res.status(409).json({
        error: 'You already have an active instance. Stop it before starting a new one.',
        instanceId: existing.id,
      });
      return;
    }

    // Find the challenge
    const challenge = await prisma.challenge.findUnique({
      where: { id: challengeId },
    });

    if (!challenge) {
      res.status(404).json({ error: 'Challenge not found' });
      return;
    }

    // Pull image if not present (non-blocking warning on failure)
    try {
      await dockerService.ensureImage(challenge.dockerImage);
    } catch (pullErr) {
      console.warn('[InstanceController] Image pull warning (continuing):', pullErr);
    }

    // Spawn the container on VM 5
    const spawnResult = await dockerService.spawnInstance(
      req.user.id,
      req.user.username,
      challenge.id,
      challenge.dockerImage,
      challenge.internalPort,
    );

    // Calculate TTL
    const expiresAt = new Date(Date.now() + config.instanceTtlMinutes * 60 * 1000);

    // Record in DB
    const instance = await prisma.instance.create({
      data: {
        userId: req.user.id,
        challengeId: challenge.id,
        containerId: spawnResult.containerId,
        containerName: spawnResult.containerName,
        subdomain: spawnResult.subdomain,
        hostUrl: spawnResult.hostUrl,
        remoteNodeIp: '192.168.200.15',
        internalPort: challenge.internalPort,
        status: InstanceStatus.RUNNING,
        expiresAt,
      },
      include: {
        challenge: {
          select: { id: true, slug: true, name: true, category: true, difficulty: true, points: true },
        },
      },
    });

    res.status(201).json({ instance });
  } catch (err) {
    console.error('[InstanceController] startMyInstance error:', err);
    res.status(500).json({ error: 'Failed to start instance' });
  }
};

export const stopMyInstance = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const instance = await prisma.instance.findFirst({
      where: {
        userId: req.user.id,
        status: { in: ACTIVE_STATUSES },
      },
    });

    if (!instance) {
      res.status(404).json({ error: 'No active instance found' });
      return;
    }

    if (instance.containerId) {
      await dockerService.destroyInstance(instance.containerId);
    }

    const updated = await prisma.instance.update({
      where: { id: instance.id },
      data: {
        status: InstanceStatus.STOPPED,
        stoppedAt: new Date(),
      },
    });

    res.status(200).json({ success: true, instance: updated });
  } catch (err) {
    console.error('[InstanceController] stopMyInstance error:', err);
    res.status(500).json({ error: 'Failed to stop instance' });
  }
};

export const extendMyInstance = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const instance = await prisma.instance.findFirst({
      where: {
        userId: req.user.id,
        status: { in: ACTIVE_STATUSES },
      },
    });

    if (!instance) {
      res.status(404).json({ error: 'No active instance found' });
      return;
    }

    const originalTtlMs = config.instanceTtlMinutes * 60 * 1000;
    const maxExpiresAt = new Date(instance.createdAt.getTime() + originalTtlMs * 2);
    const extensionMs = 30 * 60 * 1000; // 30 minutes
    const newExpiresAt = new Date(
      Math.min(instance.expiresAt.getTime() + extensionMs, maxExpiresAt.getTime()),
    );

    if (newExpiresAt <= instance.expiresAt) {
      res.status(400).json({
        error: 'Cannot extend further — maximum TTL already reached',
        expiresAt: instance.expiresAt,
      });
      return;
    }

    const updated = await prisma.instance.update({
      where: { id: instance.id },
      data: { expiresAt: newExpiresAt },
    });

    res.status(200).json({ instance: updated });
  } catch (err) {
    console.error('[InstanceController] extendMyInstance error:', err);
    res.status(500).json({ error: 'Failed to extend instance' });
  }
};
