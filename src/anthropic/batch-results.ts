import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import type { MessageBatchIndividualResponse } from "@anthropic-ai/sdk/resources/messages/batches";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { BetaMessageBatchIndividualResponse } from "@anthropic-ai/sdk/resources/beta/messages/batches";

export const MAX_IN_FLIGHT_BATCH_RECORDS = 32;

type BatchResultLine = MessageBatchIndividualResponse | BetaMessageBatchIndividualResponse;

interface BatchResultsDecoder {
  [Symbol.asyncIterator](): AsyncIterator<BatchResultLine>;
}

export function instrumentBatchResults<Decoder extends BatchResultsDecoder>(
  decoder: Decoder,
  meterSucceeded: (message: Message | BetaMessage) => Promise<void>,
): Decoder {
  const readLines = decoder[Symbol.asyncIterator].bind(decoder);

  decoder[Symbol.asyncIterator] = async function* () {
    const inFlightRecords: Promise<void>[] = [];

    for await (const line of { [Symbol.asyncIterator]: readLines }) {
      if (line.result.type === "succeeded") {
        inFlightRecords.push(meterSucceeded(line.result.message).catch(() => undefined));
      }
      if (inFlightRecords.length >= MAX_IN_FLIGHT_BATCH_RECORDS) await inFlightRecords.shift();
      yield line;
    }
  };

  return decoder;
}
