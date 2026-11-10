import { Request, Response } from 'express';
import { InstanceStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { dockerService } from '../services/docker.service';

export const getOverview = async (_req: Request, res: Response): Promise<void> => {
  try {
    const [totalUsers, activeInstances, challengesCount, recentSubmissions] = await Promise.all([
      prisma.user.count(),
      prisma.instance.count({
        where: { status: { in: [InstanceStatus.PROVISIONING, InstanceStatus.RUNNING] } },
      }),
      prisma.challenge.count(),
      prisma.submission.findMany({
        take: 10,
        orderBy: { solvedAt: 'desc' },
        include: {
          user: { select: { id: true, username: true, displayName: true } },
          challenge: { select: { id: true, slug: true, name: true, points: true } },
        },
      }),
    ]);

    res.status(200).json({
      totalUsers,
      activeInstances,
      challengesCount,
      recentSubmissions: recentSubmissions.length,
      overview: {
        totalUsers,
        activeInstances,
        challengesCount,
        recentSubmissions: recentSubmissions.length,
      },
    });
  } catch (err) {
    console.error('[AdminController] getOverview error:', err);
    res.status(500).json({ error: 'Failed to retrieve overview' });
  }
};

export const listAllInstances = async (_req: Request, res: Response): Promise<void> => {
  try {
    const instances = await prisma.instance.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, username: true, displayName: true, email: true } },
        challenge: { select: { id: true, slug: true, name: true, category: true } },
      },
    });

    // Enrich running instances with live Docker stats
    const enriched = await Promise.all(
      instances.map(async (instance) => {
        let stats = null;
        if (
          instance.status === InstanceStatus.RUNNING &&
          instance.containerId
        ) {
          stats = await dockerService.getContainerStats(instance.containerId);
        }
        return { ...instance, stats };
      }),
    );

    res.status(200).json(enriched);
  } catch (err) {
    console.error('[AdminController] listAllInstances error:', err);
    res.status(500).json({ error: 'Failed to list instances' });
  }
};

export const killInstance = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  try {
    const instance = await prisma.instance.findUnique({
      where: { id },
    });

    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }

    if (instance.containerId) {
      await dockerService.destroyInstance(instance.containerId);
    }

    const updated = await prisma.instance.update({
      where: { id },
      data: {
        status: InstanceStatus.STOPPED,
        stoppedAt: new Date(),
      },
    });

    res.status(200).json({ success: true, instance: updated });
  } catch (err) {
    console.error('[AdminController] killInstance error:', err);
    res.status(500).json({ error: 'Failed to kill instance' });
  }
};

export const getScoreboard = async (_req: Request, res: Response): Promise<void> => {
  try {
    const scoreboard = await prisma.submission.groupBy({
      by: ['userId'],
      _sum: { points: true },
      _count: { challengeId: true },
      orderBy: { _sum: { points: 'desc' } },
      take: 20,
    });

    // Enrich with user data
    const userIds = scoreboard.map((s) => s.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true, displayName: true },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));

    const ranked = scoreboard.map((entry, index) => {
      const u = userMap.get(entry.userId);
      return {
        rank: index + 1,
        userId: entry.userId,
        username: u?.username ?? 'anonymous',
        displayName: u?.displayName ?? u?.username ?? 'Anonymous',
        user: u ?? null,
        totalPoints: entry._sum.points ?? 0,
        solvedCount: entry._count.challengeId,
        challengesSolved: entry._count.challengeId,
      };
    });

    res.status(200).json(ranked);
  } catch (err) {
    console.error('[AdminController] getScoreboard error:', err);
    res.status(500).json({ error: 'Failed to retrieve scoreboard' });
  }
};
