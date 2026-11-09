import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  getOverview,
  listAllInstances,
  killInstance,
  getScoreboard,
} from '../controllers/admin.controller';

const router = Router();

router.use(authenticate, requireRole(['ADMIN']));

router.get('/overview', getOverview);
router.get('/instances', listAllInstances);
router.delete('/instances/:id', killInstance);
router.get('/scoreboard', getScoreboard);

export default router;
