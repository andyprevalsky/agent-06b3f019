import { z } from 'zod';
import { USER_UI_MAX_FILES } from '../../providers/userUi/manifest';

export {
  userUiManifestSchema,
  userUiThemeSchema,
  type UserUiManifest,
  type UserUiTheme,
} from '../../providers/userUi/manifest';

/** POST /api/user-ui/versions — the whole rose_user_ui folder, base64 per file. */
export const publishUserUiVersionSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(1024),
        contentBase64: z.string(),
      })
    )
    .min(1)
    .max(USER_UI_MAX_FILES),
  activate: z.boolean().optional(),
});
export type PublishUserUiVersionBody = z.infer<typeof publishUserUiVersionSchema>;

export const userUiVersionIdSchema = z.string().uuid();
