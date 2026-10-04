import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, authToken } from "@/lib/auth";

// Shared-password gate. With DEMO_PASSWORD unset the demo is open.
export async function proxy(request: NextRequest) {
  const password = process.env.DEMO_PASSWORD;
  if (!password) return NextResponse.next();
  const { pathname } = request.nextUrl;
  if (pathname === "/login" || pathname === "/api/login") return NextResponse.next();
  if (request.cookies.get(AUTH_COOKIE)?.value === (await authToken(password))) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Password required" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
