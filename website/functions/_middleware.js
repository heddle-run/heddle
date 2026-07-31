/**
 * playground.heddle.run is the playground, and nothing else.
 *
 * The site is one static export on one Pages project, so the playground is
 * exported at /playground and the whole site answers on every custom domain
 * the project has. This makes the subdomain behave as if it were its own
 * site: its root serves the playground — a rewrite, not a redirect, so the
 * address stays short — and every other page goes back to the apex rather
 * than existing twice at two addresses.
 *
 * Pages' _redirects file cannot do any of this: its rules match paths, not
 * hosts. Hence a Function.
 *
 * Nothing here runs unless the request is for the playground host, so a
 * mistake in it cannot reach heddle.run. Until the subdomain is added to the
 * Pages project as a custom domain, that is every request.
 *
 * Deploying it: wrangler uploads the functions directory beside the one it is
 * given, so `pages deploy out` from website/ picks up website/functions.
 */

/** The first label of the host the playground answers on. */
const PLAYGROUND_LABEL = "playground";

/** Where the export keeps it. */
const PLAYGROUND_PATH = "/playground";

const SITE = "https://heddle.run";

export async function onRequest(context) {
  try {
    const url = new URL(context.request.url);

    if (url.hostname.split(".")[0] !== PLAYGROUND_LABEL) return context.next();

    /* One spelling for each page: /playground, /playground.html and a
       trailing slash are the same request, and so are / and /index.html. */
    const path = url.pathname
      .replace(/\/index\.html$/, "/")
      .replace(/\.html$/, "")
      .replace(/\/$/, "");

    /* The root is the playground. Rewritten rather than redirected: one page,
       one address, and the reader keeps the short one. */
    if (path === "") {
      url.pathname = PLAYGROUND_PATH;
      return await context.next(new Request(url, context.request));
    }

    /* The paths it used to live at, now that this host is the shorter way to
       say both. */
    if (path === PLAYGROUND_PATH) return redirect(`/${url.search}`);
    if (path === "/compare") return redirect("/?view=compare");

    /* Assets — everything the export addresses by filename — are served from
       here, because the playground is built out of them. Pages' own /cdn-cgi
       endpoints are the edge's, and are never ours to move. */
    const file = url.pathname.split("/").pop() ?? "";
    if (file.includes(".") || url.pathname.startsWith("/cdn-cgi/")) {
      return context.next();
    }

    /* Anything else is a page of the site proper, and the site proper is at
       the apex. */
    return redirect(`${SITE}${url.pathname}${url.search}`);
  } catch {
    /* This runs in front of every request to the playground, so a throw here
       would take all of it down. Whatever went wrong, serving the request as
       it came is the right answer. */
  }

  return context.next();
}

function redirect(location) {
  return new Response(null, { status: 301, headers: { location } });
}
