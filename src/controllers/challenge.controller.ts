import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';

export const listChallenges = async (_req: Request, res: Response): Promise<void> => {
  try {
    const challenges = await prisma.challenge.findMany({
      orderBy: [{ category: 'asc' }, { difficulty: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        category: true,
        difficulty: true,
        points: true,
        dockerImage: true,
        internalPort: true,
        createdAt: true,
      },
    });

    res.status(200).json({ challenges });
  } catch (err) {
    console.error('[ChallengeController] listChallenges error:', err);
    res.status(500).json({ error: 'Failed to list challenges' });
  }
};
