/**
 * Module worker that runs the binary parsers off the main thread.
 *
 * Parsing an item is instantaneous, but a map has 262 KB of dead grid to skip
 * and tens of thousands of faces to build — enough to drop frames. The parsed
 * result contains no cycles (see `formats/relink.js`), so it crosses the worker
 * boundary through structured clone without any preparation.
 *
 * Instantiate with:
 *   new Worker(new URL('./parse.worker.js', import.meta.url), { type: 'module' })
 * which Vite, webpack 5, Parcel and Rollup all understand natively.
 */
import { parsePAT3D, parseSTAGE3D, parseINX } from '../core.js';

const PARSERS = {
  pat3d: parsePAT3D,
  stage3d: parseSTAGE3D,
  inx: parseINX,
};

self.onmessage = (event) => {
  const { id, kind, buffer } = event.data ?? {};
  const parse = PARSERS[kind];

  if (!parse) {
    self.postMessage({ id, error: `pt-loader: unknown parse kind "${kind}"` });
    return;
  }

  try {
    // `nameToIndex` is a Map and clones fine, but it is cheap to rebuild and
    // some bundler polyfills mishandle Maps — send a plain array of pairs.
    const result = parse(buffer);
    if (result.nameToIndex instanceof Map) {
      result.nameToIndex = Array.from(result.nameToIndex.entries());
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err?.message ?? String(err) });
  }
};
