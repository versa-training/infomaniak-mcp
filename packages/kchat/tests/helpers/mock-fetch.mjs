/**
 * Builds a fetch stub that answers from a queue of responses and records each call.
 * Entries are `{status, body, headers}`, or an Error to reject with.
 */
export function mockFetch(...queue) {
    const calls = [];
    const fetchStub = async (url, init = {}) => {
        calls.push({ url: new URL(url), method: init.method ?? "GET", body: init.body, signal: init.signal });
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) throw next;
        const { status = 200, body = {}, headers = {} } = next ?? {};
        return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
    };
    fetchStub.calls = calls;
    return fetchStub;
}
