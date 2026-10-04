import { NextResponse } from "next/server";
import { AUTH_COOKIE, authToken } from "@/lib/auth";
import { takeRateLimit } from "@/lib/ratelimit";

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!takeRateLimit(`login:${ip}`).ok) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  const expected = process.env.DEMO_PASSWORD;
  const { password } = (await request.json().catch(() => ({}))) as { password?: string };
  if (!expected || typeof password !== "string" || (await authToken(password)) !== (await authToken(expected))) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await authToken(expected), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 14 });
  return res;
}
