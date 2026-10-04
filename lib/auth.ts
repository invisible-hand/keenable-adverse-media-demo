export const AUTH_COOKIE = "kd_auth";

/** Cookie value for a given password. The password itself is never stored in the cookie. */
export async function authToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`keenable-demo:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
