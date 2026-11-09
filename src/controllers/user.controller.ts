import { Request, Response } from 'express';
import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';

interface UpsertUserBody {
  id: string;
  username: string;
  email: string;
  displayName: string;
  role?: string;
}

export const upsertUser = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as UpsertUserBody;

  if (!body.id || !body.username || !body.email || !body.displayName) {
    res.status(400).json({ error: 'Missing required fields: id, username, email, displayName' });
    return;
  }

  const role: Role =
    body.role === 'ADMIN' ? Role.ADMIN : Role.USER;

  try {
    const user = await prisma.user.upsert({
      where: { id: body.id },
      create: {
        id: body.id,
        username: body.username,
        email: body.email,
        displayName: body.displayName,
        role,
      },
      update: {
        username: body.username,
        email: body.email,
        displayName: body.displayName,
        role,
      },
    });

    res.status(200).json({ user });
  } catch (err) {
    console.error('[UserController] upsertUser error:', err);
    res.status(500).json({ error: 'Failed to sync user' });
  }
};

export const getMe = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        _count: {
          select: {
            instances: {
              where: {
                status: { in: ['PROVISIONING', 'RUNNING'] },
              },
            },
            submissions: true,
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.status(200).json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        activeInstanceCount: user._count.instances,
        submissionCount: user._count.submissions,
      },
    });
  } catch (err) {
    console.error('[UserController] getMe error:', err);
    res.status(500).json({ error: 'Failed to retrieve user' });
  }
};
