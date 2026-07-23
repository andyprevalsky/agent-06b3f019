import multer from 'multer';
import { MAX_FILE_SIZE } from './storage';

export const agentMessageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});
