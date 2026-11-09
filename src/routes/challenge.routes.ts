import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { listChallenges } from '../controllers/challenge.controller';

const router = Router();

router.get('/', authenticate, listChallenges);

export default router;
