import { Request, Response, NextFunction } from 'express';

export const requireRole = (roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: 'Forbidden: insufficient privileges',
        required: roles,
        current: req.user.role,
      });
      return;
    }

    next();
  };
};
