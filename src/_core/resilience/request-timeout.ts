import { METERING_REQUEST_TIMEOUT_MS } from "../constants.js";
import { MeteringTimeoutError } from "./error-handler.js";

export async function withMeteringTimeout<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), METERING_REQUEST_TIMEOUT_MS);

  try {
    return await attempt(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new MeteringTimeoutError(METERING_REQUEST_TIMEOUT_MS);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
