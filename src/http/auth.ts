import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "./errors.js";
import { config } from "../config.js";

// why this whole file exist ? 
// This file defines the UserPayload interface, 
// which represents the structure of the user information stored in the JWT token. 
// It also extends the Express Request interface to include an optional 
// user property of type UserPayload. Additionally, it provides two middleware functions: 
// requireAuth and requireRole. The requireAuth function checks for a valid JWT token 
// in the Authorization header and attaches the decoded user information to the request 
// object. The requireRole function checks if the authenticated user has the required 
// role (either "user" or "analyst") to access certain routes. If the checks fail, 
// appropriate errors are thrown.

// in easy word. explain again what this file does ? 
// This file is responsible for handling user authentication and authorization in an
// Express application. It defines the structure of the user information stored in JWT tokens,
//  extends the Express Request object to include this user information, and 
// provides middleware functions to enforce authentication and role-based access control.

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
