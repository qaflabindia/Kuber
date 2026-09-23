import { redirect, type Handle } from "@sveltejs/kit";
import { COOKIE, decode } from "$lib/server/session";

const PUBLIC = ["/signin"];

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.session = decode(event.cookies.get(COOKIE));
  const path = event.url.pathname;
  if (!event.locals.session && !PUBLIC.some((p) => path.startsWith(p))) {
    throw redirect(303, `/signin?next=${encodeURIComponent(path)}`);
  }
  const res = await resolve(event);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return res;
};
