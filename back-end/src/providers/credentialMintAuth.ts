import type { NextFunction, Request, Response } from 'express';

/** Preview logins must expire without creating credentials that outlive them. */
export function requireCredentialMintSession(
  req: Request & { user?: { authMethod?: string } },
  res: Response,
  next: NextFunction
): void {
  if (req.user?.authMethod === 'preview_handoff') {
    res.status(403).json({
      error: 'Sign in directly to create credentials',
      code: 'USER_SESSION_REQUIRED',
    });
    return;
  }
  next();
}
