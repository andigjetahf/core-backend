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
  listAdminChallenges,
  createChallenge,
  updateChallenge,
  deleteChallenge,
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

// Challenge Management CRUD
router.get('/challenges', listAdminChallenges);
router.post('/challenges', createChallenge);
router.put('/challenges/:id', updateChallenge);
router.delete('/challenges/:id', deleteChallenge);

export default router;
