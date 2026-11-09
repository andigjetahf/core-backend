import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
  getMyInstance,
  startMyInstance,
  stopMyInstance,
  extendMyInstance,
} from '../controllers/instance.controller';

const router = Router();

router.get('/me', authenticate, getMyInstance);
router.post('/start', authenticate, startMyInstance);
router.post('/stop', authenticate, stopMyInstance);
router.post('/extend', authenticate, extendMyInstance);

export default router;
