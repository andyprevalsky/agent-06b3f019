import type { Request, Response, NextFunction } from 'express';

type AsyncMiddleware<T extends Request = Request> = (
  req: T,
  res: Response,
  next: NextFunction
) => Promise<void>;

/**
 * Wraps an async Express handler/middleware so that rejected promises
 * are forwarded to Express error handling via next(err).
 *
 * Without this, passing an async function to router.get/post triggers
 * @typescript-eslint/no-misused-promises because Express expects void return.
 */
export function asyncHandler<T extends Request = Request>(
  fn: AsyncMiddleware<T>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}
