/**
 * Browser-session domain config — constants, defaults, env reads.
 */

// eslint-disable-next-line no-restricted-imports -- Express file upload middleware, configured in domain config
import multer from 'multer';

// Configure multer for file uploads (store in memory)
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
  },
});
