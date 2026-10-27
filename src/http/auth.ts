import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "./errors.js";
import { config } from "../config.js";

export interface UserPayload {
  userId: string;
  accountId: string | null;
  role: "user" | "analyst";
}

declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
    }
  }
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(
      new AppError(
        401,
        "unauthorized",
        "Missing or invalid authorization header",
      ),
    );
  }

  const token = authHeader.substring(7);
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as UserPayload;
    req.user = payload;
    next();
  } catch (err) {
    return next(new AppError(401, "unauthorized", "Invalid or expired token"));
  }
}

export function requireRole(role: "user" | "analyst"): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || req.user.role !== role) {
      return next(new AppError(403, "forbidden", `Requires ${role} role`));
    }
    next();
  };
}
