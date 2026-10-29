// Cloudflare Pages Function for /api/auth/*; all logic lives in server/auth.
import { handleAuth, type AuthEnv } from "../../../server/auth/handler.ts";

export const onRequest = (context: { request: Request; env: AuthEnv }) =>
  handleAuth(context.request, context.env);
