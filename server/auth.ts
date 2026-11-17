import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

export type UserRole = 'admin' | 'supervisor' | 'operator';

export interface AuthUserPayload {
  userId: number;
  username: string;
  fullName: string;
  role: UserRole;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUserPayload;
}

const envJwtSecret = process.env.JWT_SECRET;
const JWT_SECRET =
  envJwtSecret && envJwtSecret.length >= 16
    ? envJwtSecret
    : 'dev-wms-jwt-secret-change-before-production-32chars';

export function signToken(payload: AuthUserPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }

  const token = header.slice('Bearer '.length).trim();
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthUserPayload;
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired or invalid token. Please sign in again.' });
  }
}

export function requireRole(allowedRoles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: `Forbidden: "${req.user.role}" role does not have permission for this action.`,
      });
      return;
    }
    next();
  };
}
