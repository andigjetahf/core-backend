import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { getMe, upsertUser } from '../controllers/user.controller';

const router = Router();

router.post('/me/sync', authenticate, upsertUser);
router.get('/me', authenticate, getMe);

export default router;
