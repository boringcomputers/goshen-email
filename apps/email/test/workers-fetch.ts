// The Workers runtime rejects `redirect: "error"` with a TypeError before a request leaves the
// Worker. Node's fetch accepts it, so doubles wrapped here enforce the runtime's rule instead.
export const workersFetch = (respond: typeof fetch): typeof fetch => (input, init) =>
  init?.redirect === "error"
    ? Promise.reject(new TypeError('Invalid redirect value, must be one of "follow" or "manual"'))
    : respond(input, init)

export const redirectResponse = () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })
