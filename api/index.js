// Vercel runs the whole review site as this one function; vercel.json sends
// every address here. server.js does the work and skips its own server.
export { handle as default } from "../server.js";
