export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname.endsWith('.pages.dev')) {
    url.hostname = 'oref-map.org';
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}