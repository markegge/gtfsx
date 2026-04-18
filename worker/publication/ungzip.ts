// Tiny helper: decompress a gzip stream (R2 object body) to a UTF-8 string.
// Used by feed_info.json sidecar rendering and the ID-stability diff.

export async function ungzip(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decompressed = stream.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(decompressed).text();
}
