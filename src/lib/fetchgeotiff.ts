/**
 * Fetches a GeoTIFF's bytes. Anything other than 200 is a failure: 3xx that wasn't followed, 4xx, 5xx,
 * and 204/206 which succeed per `response.ok` but don't carry a full GeoTIFF.
 */
export const fetchGeotiff = async (url: string, signal?: AbortSignal): Promise<ArrayBuffer> => {
  const response = await fetch(url, { signal });
  if (response.status !== 200) {
    const reason = response.statusText ? ` ${response.statusText}` : '';
    throw new Error(`server responded with ${response.status}${reason}`);
  }

  const data = await response.arrayBuffer();
  if (!data.byteLength) throw new Error('the response was empty');
  return data;
};
