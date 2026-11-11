import { Request, Response } from 'express';
import { InstanceStatus, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { dockerService } from '../services/docker.service';

interface UserBasic {
  id: string;
  username: string;
  displayName: string;
}

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
      instances.map(async (instance: any) => {
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
      try {
        await dockerService.destroyInstance(instance.containerId);
      } catch (dockerErr) {
        console.warn(`[AdminController] Docker destroy warning:`, dockerErr);
      }
    }

    // Permanently remove the instance record so it does not reappear on refresh
    await prisma.instance.delete({
      where: { id },
    });

    res.status(200).json({ success: true, message: 'Instance deleted' });
  } catch (err) {
    console.error('[AdminController] killInstance error:', err);
    res.status(500).json({ error: 'Failed to kill/delete instance' });
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
    const userIds = scoreboard.map((s: { userId: string }) => s.userId);
    const users: UserBasic[] = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true, displayName: true },
    });

    const userMap = new Map<string, UserBasic>();
    for (const u of users) {
      userMap.set(u.id, u);
    }

    const ranked = scoreboard.map((entry: any, index: number) => {
      const u = userMap.get(entry.userId);
      return {
        rank: index + 1,
        userId: entry.userId,
        username: u?.username ?? 'anonymous',
        displayName: u?.displayName ?? u?.username ?? 'Anonymous',
        user: u ?? null,
        totalPoints: entry._sum?.points ?? 0,
        solvedCount: entry._count?.challengeId ?? 0,
        challengesSolved: entry._count?.challengeId ?? 0,
      };
    });

    res.status(200).json(ranked);
  } catch (err) {
    console.error('[AdminController] getScoreboard error:', err);
    res.status(500).json({ error: 'Failed to retrieve scoreboard' });
  }
};

export const listUsers = async (_req: Request, res: Response): Promise<void> => {
  try {
    const [users, pointsByUser] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              instances: true,
              submissions: true,
            },
          },
        },
      }),
      prisma.submission.groupBy({
        by: ['userId'],
        _sum: { points: true },
      }),
    ]);

    const pointsMap = new Map<string, number>();
    for (const p of pointsByUser) {
      pointsMap.set(p.userId, p._sum.points ?? 0);
    }

    const enriched = users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      instancesCount: u._count.instances,
      solvedCount: u._count.submissions,
      totalPoints: pointsMap.get(u.id) ?? 0,
    }));

    res.status(200).json(enriched);
  } catch (err) {
    console.error('[AdminController] listUsers error:', err);
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
};

export const createUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, email, displayName, role } = req.body;
    if (!username || !email || !displayName) {
      res.status(400).json({ error: 'Username, email and display name are required' });
      return;
    }

    const trimmedUsername = String(username).trim();
    const trimmedEmail = String(email).trim().toLowerCase();
    const trimmedDisplayName = String(displayName).trim();

    const existing = await prisma.user.findFirst({
      where: {
        OR: [{ username: trimmedUsername }, { email: trimmedEmail }],
      },
    });

    if (existing) {
      res.status(409).json({ error: 'Username or email already exists' });
      return;
    }

    const newUser = await prisma.user.create({
      data: {
        username: trimmedUsername,
        email: trimmedEmail,
        displayName: trimmedDisplayName,
        role: role === 'ADMIN' ? Role.ADMIN : Role.USER,
      },
    });

    res.status(201).json(newUser);
  } catch (err) {
    console.error('[AdminController] createUser error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
};

export const updateUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { username, email, displayName, role } = req.body;

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const trimmedUsername = username !== undefined ? String(username).trim() : undefined;
    const trimmedEmail = email !== undefined ? String(email).trim().toLowerCase() : undefined;
    const trimmedDisplayName = displayName !== undefined ? String(displayName).trim() : undefined;

    if (trimmedUsername && trimmedUsername !== existing.username) {
      const conflict = await prisma.user.findUnique({ where: { username: trimmedUsername } });
      if (conflict) {
        res.status(409).json({ error: 'Username is already taken' });
        return;
      }
    }

    if (trimmedEmail && trimmedEmail !== existing.email) {
      const conflict = await prisma.user.findUnique({ where: { email: trimmedEmail } });
      if (conflict) {
        res.status(409).json({ error: 'Email is already taken' });
        return;
      }
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(trimmedUsername ? { username: trimmedUsername } : {}),
        ...(trimmedEmail ? { email: trimmedEmail } : {}),
        ...(trimmedDisplayName ? { displayName: trimmedDisplayName } : {}),
        ...(role !== undefined ? { role: role === 'ADMIN' ? Role.ADMIN : Role.USER } : {}),
      },
    });

    res.status(200).json(updated);
  } catch (err) {
    console.error('[AdminController] updateUser error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
};

export const deleteUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    if (req.user?.id === id) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id },
      include: { instances: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    for (const inst of user.instances) {
      if (inst.containerId) {
        try {
          await dockerService.destroyInstance(inst.containerId);
        } catch (dockerErr) {
          console.warn(`[AdminController] Docker destroy warning for user ${id}:`, dockerErr);
        }
      }
    }

    await prisma.user.delete({ where: { id } });

    res.status(200).json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    console.error('[AdminController] deleteUser error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};

export const listAdminChallenges = async (_req: Request, res: Response): Promise<void> => {
  try {
    const challenges = await prisma.challenge.findMany({
      orderBy: [{ category: 'asc' }, { difficulty: 'asc' }, { name: 'asc' }],
      include: {
        _count: {
          select: {
            instances: true,
            submissions: true,
          },
        },
      },
    });

    const enriched = challenges.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      category: c.category,
      difficulty: c.difficulty,
      points: c.points,
      dockerImage: c.dockerImage,
      internalPort: c.internalPort,
      createdAt: c.createdAt,
      instancesCount: c._count.instances,
      solvedCount: c._count.submissions,
    }));

    res.status(200).json(enriched);
  } catch (err) {
    console.error('[AdminController] listAdminChallenges error:', err);
    res.status(500).json({ error: 'Failed to retrieve challenges' });
  }
};

export const createChallenge = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      name,
      slug,
      description,
      category,
      difficulty,
      points,
      dockerImage,
      internalPort,
    } = req.body;

    if (!name || !description) {
      res.status(400).json({ error: 'Name and description are required' });
      return;
    }

    const trimmedName = String(name).trim();
    const computedSlug = slug
      ? String(slug).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      : trimmedName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    const existing = await prisma.challenge.findUnique({
      where: { slug: computedSlug },
    });

    if (existing) {
      res.status(409).json({ error: `Challenge with slug '${computedSlug}' already exists` });
      return;
    }

    const newChallenge = await prisma.challenge.create({
      data: {
        name: trimmedName,
        slug: computedSlug,
        description: String(description).trim(),
        category: category ? String(category).trim() : 'Web Security',
        difficulty: difficulty ? String(difficulty).trim() : 'Medium',
        points: points !== undefined && !isNaN(parseInt(points, 10)) ? parseInt(points, 10) : 500,
        dockerImage: dockerImage ? String(dockerImage).trim() : 'bkimminich/juice-shop:v16.0.0',
        internalPort: internalPort !== undefined && !isNaN(parseInt(internalPort, 10)) ? parseInt(internalPort, 10) : 3000,
      },
    });

    res.status(201).json(newChallenge);
  } catch (err) {
    console.error('[AdminController] createChallenge error:', err);
    res.status(500).json({ error: 'Failed to create challenge' });
  }
};

export const updateChallenge = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const {
      name,
      slug,
      description,
      category,
      difficulty,
      points,
      dockerImage,
      internalPort,
    } = req.body;

    const existing = await prisma.challenge.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Challenge not found' });
      return;
    }

    const trimmedSlug = slug
      ? String(slug).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      : undefined;

    if (trimmedSlug && trimmedSlug !== existing.slug) {
      const conflict = await prisma.challenge.findUnique({ where: { slug: trimmedSlug } });
      if (conflict) {
        res.status(409).json({ error: `Challenge with slug '${trimmedSlug}' already exists` });
        return;
      }
    }

    const updated = await prisma.challenge.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name: String(name).trim() } : {}),
        ...(trimmedSlug !== undefined ? { slug: trimmedSlug } : {}),
        ...(description !== undefined ? { description: String(description).trim() } : {}),
        ...(category !== undefined ? { category: String(category).trim() } : {}),
        ...(difficulty !== undefined ? { difficulty: String(difficulty).trim() } : {}),
        ...(points !== undefined && !isNaN(parseInt(points, 10)) ? { points: parseInt(points, 10) } : {}),
        ...(dockerImage !== undefined ? { dockerImage: String(dockerImage).trim() } : {}),
        ...(internalPort !== undefined && !isNaN(parseInt(internalPort, 10)) ? { internalPort: parseInt(internalPort, 10) } : {}),
      },
    });

    res.status(200).json(updated);
  } catch (err) {
    console.error('[AdminController] updateChallenge error:', err);
    res.status(500).json({ error: 'Failed to update challenge' });
  }
};

export const deleteChallenge = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const challenge = await prisma.challenge.findUnique({
      where: { id },
      include: { instances: true },
    });

    if (!challenge) {
      res.status(404).json({ error: 'Challenge not found' });
      return;
    }

    for (const inst of challenge.instances) {
      if (inst.containerId) {
        try {
          await dockerService.destroyInstance(inst.containerId);
        } catch (dockerErr) {
          console.warn(`[AdminController] Docker destroy warning for challenge ${id}:`, dockerErr);
        }
      }
    }

    await prisma.challenge.delete({ where: { id } });

    res.status(200).json({ success: true, message: 'Challenge deleted successfully' });
  } catch (err) {
    console.error('[AdminController] deleteChallenge error:', err);
    res.status(500).json({ error: 'Failed to delete challenge' });
  }
};
