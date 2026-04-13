export async function onRequest(context) {
    // 1. Handle Preflight (OPTIONS) Requests immediately
    // This is required because your local browser will ask the worker for permission before making the GET request.
    if (context.request.method === "OPTIONS") {
        return new Response(null, {
            headers: {
                "Access-Control-Allow-Origin": "*", // Allows localhost during development
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Max-Age": "86400", // Cache the preflight response
            }
        });
    }

    // 2. The Official Oref Endpoint
    const OREF_URL = "https://www.oref.org.il/WarningMessages/alert/alerts.json";

    try {
        // 3. Fetch from Oref with the required bypass headers
        const orefResponse = await fetch(OREF_URL, {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': 'https://www.oref.org.il/'
            },
            // Cloudflare Workers use this config to bypass caching 
            cf: { cacheTtl: 0 } 
        });

        // 4. Read the response buffer
        const buffer = await orefResponse.arrayBuffer();

        // 5. Construct the new response with the injected CORS headers
        return new Response(buffer, {
            status: orefResponse.status,
            headers: {
                "Content-Type": "application/json;charset=utf-8",
                "Access-Control-Allow-Origin": "*", // <--- The crucial fix for your "Failed to Fetch" error
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Cache-Control": "no-store, no-cache, must-revalidate"
            }
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: "Proxy fetch failed", details: error.message }), {
            status: 500,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            }
        });
    }
}
