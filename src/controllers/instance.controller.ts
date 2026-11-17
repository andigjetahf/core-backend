import { Request, Response } from 'express';
import { InstanceStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { dockerService } from '../services/docker.service';
import { challengeHostService } from '../services/challenge-host.service';
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

    // Provision via ChallengeHoste (delegates to Proxmox LXC/VM or Docker)
    const spawnResult = await challengeHostService.provision(
      req.user.id,
      req.user.username,
      {
        id: challenge.id,
        slug: challenge.slug,
        name: challenge.name,
        runtimeType: challenge.runtimeType || 'DOCKER',
        proxmoxNode: challenge.proxmoxNode || 'pms1',
        templateId: challenge.templateId || 101,
        cpuCores: challenge.cpuCores || 1,
        ramMB: challenge.ramMB || 1024,
        diskGB: challenge.diskGB || 8,
        storagePool: challenge.storagePool || 'local-lvm',
        connectionType: challenge.connectionType || 'HTTP',
        dockerImage: challenge.dockerImage,
        internalPort: challenge.internalPort,
      }
    );

    // Calculate TTL
    const expiresAt = new Date(Date.now() + config.instanceTtlMinutes * 60 * 1000);

    // containerId is required by the DB unique constraint — use containerName as fallback
    // for Proxmox runtimes that return a synthetic "ct-node-vmid" string
    const resolvedContainerId = spawnResult.containerId || null;

    // Record in DB
    const instance = await prisma.instance.create({
      data: {
        userId: req.user.id,
        challengeId: challenge.id,
        vmid: spawnResult.vmid ?? undefined,
        proxmoxNode: spawnResult.proxmoxNode ?? undefined,
        ipAddress: spawnResult.ipAddress ?? undefined,
        connectionUrl: spawnResult.connectionUrl ?? spawnResult.hostUrl,
        containerId: resolvedContainerId ?? undefined,
        containerName: spawnResult.containerName,
        subdomain: spawnResult.subdomain,
        hostUrl: spawnResult.hostUrl,
        remoteNodeIp: spawnResult.proxmoxNode ? `${spawnResult.proxmoxNode}.ctf.local` : '192.168.200.15',
        internalPort: challenge.internalPort,
        status: InstanceStatus.RUNNING,
        expiresAt,
      },
      include: {
        challenge: {
          select: { id: true, slug: true, name: true, category: true, difficulty: true, points: true, runtimeType: true, proxmoxNode: true },
        },
      },
    });

    res.status(201).json({ instance });
  } catch (err: any) {
    console.error('[InstanceController] startMyInstance error:', err);
    res.status(500).json({ error: 'Failed to start instance', details: err?.message });
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
      include: {
        challenge: true,
      },
    });

    if (!instance) {
      res.status(404).json({ error: 'No active instance found' });
      return;
    }

    // Deprovision via ChallengeHoste (stops & cleans up Proxmox VM/CT or Docker)
    await challengeHostService.deprovision({
      vmid: instance.vmid,
      proxmoxNode: instance.proxmoxNode,
      runtimeType: instance.challenge?.runtimeType,
      containerId: instance.containerId,
      containerName: instance.containerName,
    });

    // Permanently delete or mark stopped. Deleting allows user to immediately restart
    // without hitting unique constraints (subdomain, containerName, vmid)
    await prisma.instance.delete({
      where: { id: instance.id },
    });

    res.status(200).json({ success: true, message: 'Instance stopped and removed' });
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
