const SERVICE_PATH_SUFFIX = /\/+(?:(?:meter|profitstream)(?:\/+v2(?:\/+api)?)?|v2)\/*$/i;
const TRAILING_SLASHES = /\/+$/;

function stripServicePath(path: string): string {
  return path.replace(TRAILING_SLASHES, "").replace(SERVICE_PATH_SUFFIX, "");
}

export function stripReveniumServicePrefix(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}${stripServicePath(url.pathname)}`;
  } catch {
    return stripServicePath(baseUrl);
  }
}
