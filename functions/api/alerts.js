export async function onRequest(context) {
    if (context.request.method === "OPTIONS") {
        return new Response(null, {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
            }
        });
    }

    try {
        const orefResponse = await fetch("https://www.oref.org.il/WarningMessages/alert/alerts.json", {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': 'https://www.oref.org.il/'
            },
            cf: { cacheTtl: 0 } 
        });

        const buffer = await orefResponse.arrayBuffer();

        return new Response(buffer, {
            status: orefResponse.status,
            headers: {
                "Content-Type": "application/json;charset=utf-8",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Cache-Control": "no-store, no-cache, must-revalidate"
            }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: "Alert proxy failed" }), { status: 500 });
    }
}
