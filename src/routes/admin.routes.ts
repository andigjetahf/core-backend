import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  getOverview,
  listAllInstances,
  killInstance,
  getScoreboard,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
} from '../controllers/admin.controller';

const router = Router();

router.use(authenticate, requireRole(['ADMIN']));

router.get('/overview', getOverview);
router.get('/instances', listAllInstances);
router.delete('/instances/:id', killInstance);
router.get('/scoreboard', getScoreboard);

// User Management CRUD
router.get('/users', listUsers);
router.post('/users', createUser);
router.put('/users/:id', updateUser);
router.delete('/users/:id', deleteUser);

export default router;
