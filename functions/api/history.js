export async function onRequest(context) {
    // 1. Handle Preflight (OPTIONS) Requests immediately for CORS
    if (context.request.method === "OPTIONS") {
        return new Response(null, {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Max-Age": "86400",
            }
        });
    }

    // 2. The Official Oref History Endpoint
    const OREF_HISTORY_URL = "https://www.oref.org.il/WarningMessages/History/Web/History.json";

    try {
        // 3. Fetch from Oref with the required bypass headers
        const orefResponse = await fetch(OREF_HISTORY_URL, {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': 'https://www.oref.org.il/'
            },
            // Prevent Cloudflare from serving stale history data
            cf: { cacheTtl: 0 } 
        });

        // 4. Read the response buffer (handles BOM natively)
        const buffer = await orefResponse.arrayBuffer();

        // 5. Construct the new response with the injected CORS headers
        return new Response(buffer, {
            status: orefResponse.status,
            headers: {
                "Content-Type": "application/json;charset=utf-8",
                "Access-Control-Allow-Origin": "*", // The crucial CORS fix
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Cache-Control": "no-store, no-cache, must-revalidate"
            }
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: "History proxy fetch failed", details: error.message }), {
            status: 500,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            }
        });
    }
}
