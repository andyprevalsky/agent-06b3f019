import { type Request, type Response, Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import { resumeUpload } from './config';
import { NotificationError, ValidationError, submitApplication } from './service';

const log = createLogger('Careers');
const router = Router();

// POST /api/careers/applications - Submit a job application (no auth required)
router.post(
  '/applications',
  resumeUpload.single('resume') as unknown as Parameters<typeof router.post>[1],
  asyncHandler(async (req: Request, res: Response) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    const body = req.body as Record<string, unknown>;

    try {
      const result = await submitApplication({
        roleSlug: String(body.role_slug ?? ''),
        name: String(body.name ?? ''),
        email: String(body.email ?? ''),
        linkedin: String(body.linkedin ?? ''),
        resume:
          file === undefined
            ? { filename: '', mimeType: '', content: Buffer.alloc(0) }
            : {
                filename: file.originalname,
                mimeType: file.mimetype,
                content: file.buffer,
              },
      });
      res.status(201).json({ success: true, notified: result.notified.length });
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof NotificationError) {
        res.status(502).json({ error: error.message });
        return;
      }
      log.error('Application submission error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Could not submit your application. Please try again.' });
    }
  })
);

export default router;
