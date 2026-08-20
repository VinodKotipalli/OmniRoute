type JsonRecord = Record<string, unknown>;

const SERVER_ITEM_ID_PATTERN = /^(rs|fc|resp|msg)_/;

/**
 * Applies the persistence-independent policy for replayed Responses input items.
 * Stored references can only be resolved by the upstream that created them, so
 * they are always removed. Self-contained encrypted reasoning is retained only
 * when the selected connection explicitly opts in. Plaintext reasoning_text is
 * retained only when the caller identifies a target that supports stateless replay.
 */
export function applyResponsesInputPolicy(
  body: Record<string, unknown>,
  preserveEncryptedReasoning = false,
  preservePlaintextReasoning = false
): void {
  if (Array.isArray(body.input) && body.input.length === 0) {
    body.input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue" }],
      },
    ];
  }

  if (!Array.isArray(body.input)) return;

  body.input = body.input.flatMap((item) => {
    if (typeof item === "string" && SERVER_ITEM_ID_PATTERN.test(item)) {
      return [];
    }

    const record =
      item && typeof item === "object" && !Array.isArray(item) ? (item as JsonRecord) : null;
    if (!record) return [item];

    if (record.type === "item_reference") {
      return [];
    }

    const nextRecord = { ...record };

    if (nextRecord.type === "reasoning") {
      if (preservePlaintextReasoning) {
        const content = Array.isArray(nextRecord.content)
          ? nextRecord.content.flatMap((part) => {
              if (!part || typeof part !== "object" || Array.isArray(part)) return [];
              const contentPart = part as JsonRecord;
              if (
                contentPart.type !== "reasoning_text" ||
                typeof contentPart.text !== "string" ||
                contentPart.text.trim().length === 0
              ) {
                return [];
              }
              return [{ type: "reasoning_text", text: contentPart.text }];
            })
          : [];
        if (content.length === 0) return [];

        nextRecord.content = content;
        delete nextRecord.encrypted_content;
        delete nextRecord.summary;
      } else if (
        !preserveEncryptedReasoning ||
        typeof nextRecord.encrypted_content !== "string" ||
        nextRecord.encrypted_content.trim().length === 0
      ) {
        return [];
      }
    }

    if (typeof nextRecord.id === "string" && SERVER_ITEM_ID_PATTERN.test(nextRecord.id)) {
      delete nextRecord.id;
    }

    return [nextRecord];
  });
}
